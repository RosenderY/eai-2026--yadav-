"""
Aggregator Service
==================
Collect item results from orders.results, grouped by orderId.

- Complete when every distinct item result has arrived.
- Emit a partial result after an idle timeout.
- Ignore duplicate item results.
- Keep concurrent orders separate.

Consumes from: orders.results
Publishes to:  orders.complete
"""

import json
import pika
import os
import threading
import time


# In-memory aggregation state.
# orderId -> {
#   'correlationId': str,
#   'totalItems': int,
#   'results': {itemIndex: result_message},
#   'last_activity': float
# }
in_flight = {}

# Remember finished orders so a late duplicate cannot create a second
# completion message for the same order.
completed_orders = set()

lock = threading.Lock()

# Idle timeout required by PA3. It resets whenever a valid result arrives.
IDLE_TIMEOUT_SECONDS = float(
    os.environ.get('AGGREGATOR_IDLE_TIMEOUT_SECONDS', '5')
)

SWEEP_INTERVAL_SECONDS = 1.0


def get_rabbitmq_connection():
    """Create a connection to RabbitMQ using environment variable for host."""
    return pika.BlockingConnection(
        pika.ConnectionParameters(
            host=os.environ.get('RABBITMQ_HOST', 'localhost')
        )
    )


def publish_completion(message):
    """Publish one final result to orders.complete."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()
    channel.queue_declare(queue='orders.complete', durable=True)
    channel.basic_publish(
        exchange='',
        routing_key='orders.complete',
        body=json.dumps(message),
        properties=pika.BasicProperties(delivery_mode=2)
    )
    connection.close()


def build_completion(order_id, state, status):
    """Build the exact completion-message shape required by PA3."""
    total_items = state['totalItems']
    results_by_index = state['results']

    received_indexes = set(results_by_index.keys())
    missing_indexes = [
        index
        for index in range(total_items)
        if index not in received_indexes
    ]

    return {
        'orderId': order_id,
        'correlationId': state['correlationId'],
        'status': status,
        'totalItems': total_items,
        'receivedItems': len(results_by_index),
        'itemResults': list(results_by_index.values()),
        'missingItemIndexes': missing_indexes
    }


def aggregate_result(ch, method, properties, body):
    """Collect one worker result and complete the order when all items arrive."""
    completion = None

    try:
        result = json.loads(body)

        order_id = result['orderId']
        correlation_id = result['correlationId']
        item_index = result['itemIndex']
        total_items = result['totalItems']

        if not isinstance(item_index, int) or not isinstance(total_items, int):
            raise ValueError('itemIndex and totalItems must be integers')

        if item_index < 0 or item_index >= total_items or total_items <= 0:
            raise ValueError('invalid itemIndex/totalItems values')

        now = time.time()

        with lock:
            # A late redelivery after completion must not produce a second
            # orders.complete message.
            if order_id in completed_orders:
                print(
                    f"[Aggregator] Ignoring late duplicate for "
                    f"completed order {order_id}, item {item_index}"
                )
            else:
                state = in_flight.get(order_id)

                if state is None:
                    state = {
                        'correlationId': correlation_id,
                        'totalItems': total_items,
                        'results': {},
                        'last_activity': now
                    }
                    in_flight[order_id] = state

                # Keep one result per itemIndex. Re-delivery overwrites the
                # same slot instead of increasing the count.
                state['results'][item_index] = result
                state['last_activity'] = now

                if len(state['results']) == state['totalItems']:
                    completion = build_completion(
                        order_id,
                        state,
                        'complete'
                    )
                    del in_flight[order_id]
                    completed_orders.add(order_id)

        if completion is not None:
            publish_completion(completion)
            print(
                f"[Aggregator] Completed order {order_id} "
                f"with {completion['receivedItems']} items"
            )

    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        print(f"[Aggregator] Ignoring malformed result: {exc}")

    finally:
        # Bad messages are acknowledged too, so one poison message cannot
        # block the queue forever.
        ch.basic_ack(delivery_tag=method.delivery_tag)


def sweep_timeouts():
    """Publish partial results for orders that have been idle too long."""
    while True:
        time.sleep(SWEEP_INTERVAL_SECONDS)

        now = time.time()
        timed_out = []

        with lock:
            for order_id, state in list(in_flight.items()):
                idle_for = now - state['last_activity']

                if idle_for >= IDLE_TIMEOUT_SECONDS:
                    completion = build_completion(
                        order_id,
                        state,
                        'partial'
                    )
                    timed_out.append(completion)

                    del in_flight[order_id]
                    completed_orders.add(order_id)

        # Do network I/O after releasing the state lock.
        for completion in timed_out:
            publish_completion(completion)
            print(
                f"[Aggregator] Order {completion['orderId']} timed out; "
                f"missing items {completion['missingItemIndexes']}"
            )


def main():
    """Connect to RabbitMQ, start timeout sweep, consume worker results."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()

    channel.queue_declare(queue='orders.results', durable=True)
    channel.queue_declare(queue='orders.complete', durable=True)

    channel.basic_qos(prefetch_count=1)

    sweeper = threading.Thread(target=sweep_timeouts, daemon=True)
    sweeper.start()

    channel.basic_consume(
        queue='orders.results',
        on_message_callback=aggregate_result
    )

    print('[Aggregator] Waiting for results...')
    channel.start_consuming()


if __name__ == '__main__':
    main()

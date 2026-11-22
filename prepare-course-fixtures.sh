#!/bin/sh
# Restore the instructor's sample inputs to this local checkout for testing.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
revision=2a4e529a4f51104b27031b1cb1b7805f90443c05
for file in pa1/data/customers.csv pa1/data/orders-20260901.txt pa7/tests/public/fixtures/order.json capstone/tests/fixtures/b2b-order.xml capstone/tests/fixtures/mobile-order.json capstone/tests/fixtures/web-order.json
do
  target=$root/$file
  [ -f "$target" ] && continue
  mkdir -p "$(dirname "$target")"
  tmp=$(mktemp "$target.XXXXXX")
  if curl -fsSL "https://raw.githubusercontent.com/mleitass/eai-2026/$revision/$file" -o "$tmp"; then
    mv "$tmp" "$target"
  else
    rm -f "$tmp"
    exit 1
  fi
done

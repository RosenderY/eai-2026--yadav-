import Ajv from 'ajv';
import formats from 'ajv-formats';
import fs from 'node:fs';
const ajv=new Ajv({strict:false});
formats(ajv);
export const validOrder=ajv.compile(JSON.parse(fs.readFileSync(process.env.ORDER_SCHEMA ?? '/canonical/order.schema.json')));

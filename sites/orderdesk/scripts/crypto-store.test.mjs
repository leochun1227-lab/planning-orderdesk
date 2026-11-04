import test from 'node:test';
import assert from 'node:assert/strict';
import {seal,unseal} from '../lib/crypto-store.mjs';
test('compressed state roundtrip and tamper rejection',async()=>{const key='ab'.repeat(32),value={orders:{ABC123:{customer:'客户 Example',dealer:'Test'}}};const sealed=await seal(value,key);assert.equal(sealed.version,2);assert.ok(!JSON.stringify(sealed).includes('客户'));assert.deepEqual(await unseal(sealed,key),value);await assert.rejects(()=>unseal(sealed,'cd'.repeat(32)));const bad={...sealed,data:'AAAA'+sealed.data.slice(4)};await assert.rejects(()=>unseal(bad,key));});

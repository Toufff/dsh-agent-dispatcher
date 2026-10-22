import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DomainStore} from '../src/store.js';
test('domain save skips unchanged state, retries transient locks, and preserves old value on permanent failure',async()=>{
 let value={count:0},calls=0,failures=2;
 const domain={global:{get:()=>value,set:async next=>{calls++;if(failures-->0)throw Object.assign(new Error('locked'),{code:'EPERM'});value=next;}}};
 const store=new DomainStore(domain);await store.save({count:0});assert.equal(calls,0);
 await store.save({count:1});assert.equal(calls,3);assert.equal(value.count,1);
 failures=10;await assert.rejects(store.save({count:2}),/locked/);assert.equal(value.count,1);
 failures=0;await store.save({count:3});assert.equal(value.count,3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackup, parseBackup, matchBackup } from '../backup.js';
import { transactionDone } from '../storage.js';
const entries = [{id:'one',name:'sample.mp4',size:99,lastModified:123,duration:4}];
const settings = {mode:'count',repeatCount:3,keepAwake:true};
test('settings backup round-trip contains no videos or session blob URLs', () => {
  const backup = makeBackup(entries,settings); const text=JSON.stringify(backup);
  assert.equal(backup.includesVideos,false); assert.equal(text.includes('blob:'),false);
  const result=parseBackup(text); assert.deepEqual(result.settings,settings); assert.equal(result.playlist.length,1);
});
test('hostile and malformed backups are rejected before mutation', () => {
  assert.throws(()=>parseBackup('not json'));
  for(const overrides of [{app:'another-app'},{schemaVersion:9},{includesVideos:true},{settings:{...settings,repeatCount:0}},{settings:{...settings,mode:'x'}},{playlist:[{...entries[0],size:-1}]}]) {
    assert.throws(()=>parseBackup(JSON.stringify({...makeBackup(entries,settings),...overrides})));
  }
  assert.throws(()=>parseBackup(' '.repeat(2_000_001)));
});
test('same filename alone never silently picks a restore candidate', () => {
  const playlist = makeBackup(entries,settings).playlist;
  assert.equal(matchBackup(playlist,entries)[0].id,'one');
  assert.equal(matchBackup(playlist,[{...entries[0],size:100}])[0].id,'');
  assert.equal(matchBackup(playlist,[...entries,{...entries[0],id:'two'}])[0].id,'');
});
test('one stored file cannot be assigned twice automatically', () => {
  const item=makeBackup(entries,settings).playlist[0]; const match=matchBackup([item,item],entries);
  assert.equal(match[0].id,'one'); assert.equal(match[1].id,'');
});
test('transaction success waits for actual commit completion, not a request result', async () => {
  const tx = new EventTarget(); let complete=false;
  const promise=transactionDone(tx).then(()=>{complete=true;});
  await Promise.resolve(); assert.equal(complete,false);
  tx.dispatchEvent(new Event('complete')); await promise; assert.equal(complete,true);
});
test('transaction abort rejects saving rather than displaying saved', async () => {
  const tx = new EventTarget(); tx.error=new DOMException('full','QuotaExceededError');
  const promise=transactionDone(tx); tx.dispatchEvent(new Event('abort'));
  await assert.rejects(promise,{name:'QuotaExceededError'});
});

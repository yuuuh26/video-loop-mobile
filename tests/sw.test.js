import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
function setup() {
  const listeners={}, added=[],deleted=[],fetched=[],matched=[];
  const context={URL,Request,Set,Promise,
    self:{location:{href:'https://example.github.io/video-loop-mobile/sw.js'},clients:{claim:async()=>{}},skipWaiting:()=>{},addEventListener:(name,fn)=>listeners[name]=fn},
    caches:{keys:async()=>['another-app-cache','yuu-video-loop-mobile-shell-v0','yuu-video-loop-mobile-shell-v1.0.1'],delete:async name=>deleted.push(name),
      open:async()=>({addAll:async requests=>added.push(...requests),match:async target=>{matched.push(target);return {cached:true};}})},
    fetch:async request=>{fetched.push(request);return {fetched:true};}
  };
  vm.runInNewContext(source,context);
  return {listeners,added,deleted,fetched,matched};
}
test('offline installation caches only app assets and omits credentials', async()=>{
  const {listeners,added}=setup(); let task;
  listeners.install({waitUntil:value=>{task=value;}}); await task;
  assert.equal(added.length,11);
  for(const request of added){assert.equal(request.credentials,'omit');assert.equal(request.url.startsWith('https://example.github.io/video-loop-mobile/'),true);assert.equal(/\.(mp4|mov|webm)$/.test(request.url),false);}
});
test('activation only deletes old caches belonging to this app',async()=>{
  const {listeners,deleted}=setup();let task;listeners.activate({waitUntil:value=>{task=value;}});await task;
  assert.deepEqual(deleted,['yuu-video-loop-mobile-shell-v0']);
});
test('navigation uses cached app shell rather than sending user state',async()=>{
  const {listeners,matched,fetched}=setup();let task;
  listeners.fetch({request:new Request('https://example.github.io/video-loop-mobile/'),respondWith:value=>{task=value;}});await task;
  assert.deepEqual(matched,['https://example.github.io/video-loop-mobile/index.html']);assert.equal(fetched.length,0);
});
test('worker never intercepts user videos, foreign apps, post requests, or data in queries',()=>{
  const {listeners,matched,fetched}=setup();
  for(const url of ['https://example.github.io/video-loop-mobile/private.mp4','https://example.github.io/other-app/index.html','https://external.example/app.js','https://example.github.io/video-loop-mobile/app.js?filename=private']){
    listeners.fetch({request:new Request(url),respondWith:()=>{throw new Error('should not intercept');}});
  }
  listeners.fetch({request:new Request('https://example.github.io/video-loop-mobile/app.js',{method:'POST'}),respondWith:()=>{throw new Error('post not allowed');}});
  assert.equal(matched.length,0);assert.equal(fetched.length,0);
});

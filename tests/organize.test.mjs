import test from 'node:test';
import assert from 'node:assert/strict';
import { dateGroups, toneFromPixels, paletteGroups, shapeGroups } from '../src/organize.js';
import { exportAlbums } from '../src/archive.js';
import { unzipSync } from '../vendor/fflate.mjs';

test('same-day sessions preserve unknown dates and use a 90-minute gap', () => {
  const photos = [null, [9,15], [15,0], [9,55]].map((t,i) => ({id:String(i),date:t && new Date(2026,3,4,...t)}));
  assert.deepEqual(dateGroups(photos).map(g => g.photoIds), [['0'],['1','3'],['2']]);
});
test('many shooting days spanning months group by month', () => {
  const images = Array.from({length:18}, (_,i) => ({id:i,date:new Date(2026,0,24+i)}));
  assert.deepEqual(dateGroups(images).map(g=>g.name),['2026-01','2026-02']);
  assert.deepEqual(dateGroups([{id:'absent',date:null}]),[]);
});
test('dominant color distinguishes blue, greenery, and neutral areas', () => {
  const swatch = rgb => toneFromPixels(new Uint8ClampedArray([...rgb,255]));
  const photos = [[40,80,200],[34,130,35],[85,85,85],[241,241,241]].map((rgb,id)=>({id,palette:swatch(rgb)}));
  assert.deepEqual(paletteGroups(photos).map(group=>group.id),['blue','green','ink','silver']);
});
test('orientation plan keeps all source ids including square frames', () => {
  const groups=shapeGroups([{id:1,width:3,height:2},{id:2,width:2,height:3},{id:3,width:3,height:3}]);
  assert.deepEqual(groups.map(g=>[g.id,...g.photoIds]),[['landscape',1],['portrait',2],['square',3]]);
});
test('export preserves bytes and disambiguates colliding names and unsafe paths', async () => {
  const names=['a.jpg','A.jpg','CON.jpg','../x.jpg','note.jpg'];
  const photos=names.map((name,i)=>({id:i,name,blob:new Blob([new Uint8Array([i,255,2])])}));
  const zip=await exportAlbums(photos,[{name:'A',photoIds:[0,1,2,3]},{name:'a',photoIds:[4]}]);
  const unpacked=unzipSync(new Uint8Array(await zip.arrayBuffer()));
  const manifest=JSON.parse(new TextDecoder().decode(unpacked['album-atlas.json']));
  assert.deepEqual(manifest.photos.map(p=>p.path),['A/a.jpg','A/A (2).jpg','A/_CON.jpg','A/.._x.jpg','a (2)/note.jpg']);
  manifest.photos.forEach(({path,bytes},i)=>{assert.equal(bytes,3);assert.deepEqual([...unpacked[path]],[i,255,2]);});
});
test('reject incomplete, repeated and empty exports',async ()=>{
  const photos=[{id:'a',name:'a.jpg',blob:new Blob(['a'])},{id:'b',name:'b.jpg',blob:new Blob(['b'])}];
  await assert.rejects(exportAlbums(photos,[{name:'A',photoIds:['a']}]),/destination/);
  await assert.rejects(exportAlbums(photos,[{name:'A',photoIds:['a','a']}]),/repeated/);
  await assert.rejects(exportAlbums(photos,[]),/No photos/);
});

const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync('./story.js','utf8')+';this.__o={SCENES};';
const c={console};c.window=c;vm.createContext(c);vm.runInContext(src,c);
const {SCENES}=c.__o;const types=['empathy','bystander','indifferent','knowledge'];
const mk=(t,own)=>({type:t,own,scores:{e:.5,u:.5,a:.5},v:{kind:3,harm:3,watch:3,hope:3,despair:3},sceneId:'',cp:'',log:[]});
const seen=new Set(),cnt={},map={};
for(const [id,sc] of Object.entries(SCENES)){
  const vs=typeof sc.lines==='function'?[...types.map(t=>mk(t,false)),mk('empathy',true)]:[null];
  for(const S of vs){let L;try{L=S?sc.lines(S):sc.lines}catch(e){continue}if(!Array.isArray(L))continue;
    for(const l of L){if(!Array.isArray(l)||!l[1]||l[0]==='n'||l[0]==='fx')continue;const k=l[0]+'|'+l[1];if(seen.has(k))continue;seen.add(k);
      cnt[l[0]]=(cnt[l[0]]||0)+1;map[k]=l[0]+'_'+String(cnt[l[0]]).padStart(3,'0');}}}
const have=fs.readdirSync('./assets/voice/lines').filter(f=>f.endsWith('.wav')).map(f=>f.replace('.wav',''));
fs.writeFileSync('./voicemap.js','/* 自動生成: セリフ→ボイスファイル。gen_map.js で更新 */\nconst LINE_VOICE='+JSON.stringify(map)+';\nconst LINE_HAVE=new Set('+JSON.stringify(have)+');\n');
console.log(Object.keys(map).length,'lines;',have.length,'files; mom keys:',Object.entries(map).filter(([k,v])=>v.startsWith('mom')).map(([k,v])=>v));

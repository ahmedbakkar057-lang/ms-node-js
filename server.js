const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const {spawn, spawnSync, execFile} = require('child_process');
const {performance} = require('perf_hooks');

const BASE_DIR = __dirname;
const IS_VERCEL = Boolean(process.env.VERCEL);
const RUNTIME_DIR = process.env.RUNTIME_DIR || (IS_VERCEL ? path.join('/tmp','ms-host') : BASE_DIR);
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
const USERS_DIR = process.env.USERS_DIR || path.join(RUNTIME_DIR, 'USERS');
const DB_FILE = process.env.DB_FILE || path.join(RUNTIME_DIR, 'db.json');
const PORT = Number(process.env.PORT || 5000);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'wemohammed1@gmail.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bakkar12';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '@M_s_261285';
const PUBLIC_REGISTRATION = String(process.env.PUBLIC_REGISTRATION ?? 'true').toLowerCase() !== 'false';
const PORT_RANGE_START = 8100, PORT_RANGE_END = 9100;
let db;
const sessions = new Map();
const children = new Map();
const startedAt = new Map();
fs.mkdirSync(USERS_DIR, {recursive: true});

const now = () => new Date().toISOString().replace('T',' ').replace('Z','');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const key = () => crypto.randomBytes(32).toString('base64url');
const safeName = email => email.replace(/@/g, '_at_').replace(/\./g, '_dot_');
const stamp = () => Math.floor(Date.now()/1000);
const defaultPlans = () => ({
  basic:{name:'أساسية',storage:102400,ram:512,cpu:0.5,max_servers:5,price:0},
  premium:{name:'احترافية',storage:512000,ram:2048,cpu:1.5,max_servers:15,price:9.99},
  ultimate:{name:'أسطورية',storage:2048000,ram:8192,cpu:4,max_servers:30,price:24.99}
});
function saveDB(data=db){fs.writeFileSync(DB_FILE, JSON.stringify(data,null,2), 'utf8');}
function loadDB(){
  let data;
  try { data=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch (_) { data=null; }
  if (!data) data={users:{},servers:{},logs:[],plans:defaultPlans()};
  data.users ||= {}; data.servers ||= {}; data.logs ||= []; data.plans ||= defaultPlans(); data.sessions ||= {};
  const currentTime=Date.now(); for (const [token,session] of Object.entries(data.sessions)) if (!session?.email || session.expires<=currentTime) delete data.sessions[token];
  if (!data.plans.basic) Object.assign(data.plans, defaultPlans());
  if (!data.users[ADMIN_EMAIL]) {
    const legacy=Object.keys(data.users).find(e=>data.users[e]?.is_admin);
    if (legacy) data.users[ADMIN_EMAIL]=data.users[legacy], delete data.users[legacy];
  }
  if (!data.users[ADMIN_EMAIL]) data.users[ADMIN_EMAIL]={created_at:now(),max_servers:999999,expiry_days:3650,telegram_id:null,api_key:null,storage_limit:10240000,plan:'admin'};
  data.users[ADMIN_EMAIL].password=hash(ADMIN_PASSWORD);
  data.users[ADMIN_EMAIL].is_admin=true;
  saveDB(data); return data;
}
db=loadDB();
// Child processes do not survive a server restart; never expose stale Running states.
for (const srv of Object.values(db.servers)) {
  if (srv.status === 'Running') { srv.status = 'Stopped'; srv.pid = null; }
}
saveDB();

function cookieToken(req){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ms_session='))?.split('=')[1]||null;}
function sessionEmail(req){
  const token=cookieToken(req); if(!token)return null;
  const inMemory=sessions.get(token); if(inMemory)return inMemory;
  const persisted=db.sessions?.[token];
  if(persisted?.email && persisted.expires>Date.now()){sessions.set(token,persisted.email);return persisted.email;}
  return null;
}
function setSession(res,email){const token=key(),expires=Date.now()+2592000000; sessions.set(token,email); db.sessions[token]={email,expires}; saveDB(); res.setHeader('Set-Cookie',`ms_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);}
function clearSession(req,res){const token=cookieToken(req); if(token){sessions.delete(token);delete db.sessions[token];saveDB();} res.setHeader('Set-Cookie','ms_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');}
function user(req){const email=sessionEmail(req); return email ? db.users[email] : null;}
function isAdmin(email){return email===ADMIN_EMAIL || !!db.users[email]?.is_admin;}
function jsonFail(res,message='غير مصرح',code=200){return res.status(code).json({success:false,message});}
function body(req){return req.body||{};}
function apiAuth(req,res){const email=sessionEmail(req); if(!email)return jsonFail(res,'غير مصرح',401); return email;}
function apiKeyUser(k){for(const [email,u] of Object.entries(db.users))if(u.api_key===k)return [email,u];return [null,null];}
function adminAuth(req,res){const email=sessionEmail(req); if(email&&isAdmin(email))return email; const [e]=apiKeyUser(body(req).api_key||req.query.api_key); if(e&&isAdmin(e))return e; return null;}
function uptime(t){if(!t)return '0 ثانية';const d=Math.max(0,Date.now()/1000-t);const a=[];if(d>=86400)a.push(Math.floor(d/86400)+'ي');if(d%86400>=3600)a.push(Math.floor(d%86400/3600)+'س');if(d%3600>=60)a.push(Math.floor(d%3600/60)+'د');return a.join(' ')||'< دقيقة';}
function userDir(email){const p=path.join(USERS_DIR,safeName(email),'SERVERS');fs.mkdirSync(p,{recursive:true});return p;}
function folderPath(srv){return srv.path;}
function publicIp(){return process.env.PUBLIC_IP||'127.0.0.1';}
function sizeText(n){return n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;}
function dirSize(p){let total=0;try{for(const e of fs.readdirSync(p,{withFileTypes:true})){const x=path.join(p,e.name);if(e.isDirectory())total+=dirSize(x);else total+=fs.statSync(x).size;}}catch(_){}return total;}
function mainFile(dir){const candidates=['index.js','server.js','app.js','main.js','bot.js','start.js'];for(const f of candidates)if(fs.existsSync(path.join(dir,f)))return f;try{return fs.readdirSync(dir).find(f=>/\.(js|mjs|cjs)$/.test(f))||'';}catch(_){return '';}}
function nodeCommand(file){return [process.execPath,[file]];}
function logHeader(srv,file){const p=path.join(srv.path,'out.log');fs.appendFileSync(p,`\n${'='.repeat(50)}\n🚀 تشغيل Node.js — ${now()}\n📁 ${file} | 🔌 منفذ: ${srv.port}\n${'='.repeat(50)}\n\n`);return p;}
function startServer(folder){
  if(IS_VERCEL)return [false,'تشغيل البوتات الدائمة غير متاح على Vercel؛ استخدم VPS أو Render أو Railway للبوتات'];
  const srv=db.servers[folder];
  if(!srv)return [false,'السيرفر غير موجود'];
  const file=srv.startup_file||mainFile(srv.path);
  if(!file)return [false,'لا يوجد ملف Node.js (.js/.mjs/.cjs) للتشغيل'];
  const fp=path.join(srv.path,file);
  if(!fs.existsSync(fp))return [false,`الملف '${file}' غير موجود`];
  srv.startup_file=file; srv.port||=assignedPort();
  const logPath=logHeader(srv,file);
  const errorPath=path.join(srv.path,'errors.log');
  const appendLog=text=>{try{fs.appendFileSync(logPath, text)}catch(_){} };
  const env={...process.env,PORT:String(srv.port),SERVER_PORT:String(srv.port),NODE_ENV:'production'};
  // Node projects uploaded from a ZIP normally have package.json but no node_modules.
  // Install dependencies before launch and stream npm output into the same console log.
  if(fs.existsSync(path.join(srv.path,'package.json'))&&!fs.existsSync(path.join(srv.path,'node_modules'))){
    appendLog(`\n$ npm install --omit=dev\n`);
    const install=spawnSync('npm',['install','--omit=dev'],{cwd:srv.path,env,encoding:'utf8',timeout:180000});
    appendLog(install.stdout||''); appendLog(install.stderr||'');
    if(install.error||install.status!==0){appendLog(`\n❌ فشل تثبيت المكتبات (exit ${install.status??'error'})\n`);return [false,'فشل تثبيت مكتبات Node.js — راجع شاشة الأوامر'];}
    appendLog('\n✅ اكتمل تثبيت مكتبات Node.js\n');
  }
  const out=fs.openSync(logPath,'a');
  const err=fs.openSync(errorPath,'a');
  const [cmd,args]=nodeCommand(file);
  const child=spawn(cmd,args,{cwd:srv.path,env,stdio:['ignore',out,err],detached:true});
  child.on('error',e=>appendLog(`\n❌ خطأ تشغيل Node.js: ${e.message}\n`));
  child.on('exit',(code,signal)=>{appendLog(`\n⏹ انتهى التشغيل — code=${code??'null'} signal=${signal||'—'}\n`);if(children.get(folder)===child){children.delete(folder);srv.status='Stopped';srv.pid=null;startedAt.delete(folder);saveDB();}});
  child.unref(); children.set(folder,child); startedAt.set(folder,Date.now()/1000); srv.pid=child.pid; srv.status='Running'; saveDB();
  appendLog(`🚀 بدأ Node.js PID=${child.pid}\n`);
  return [true,'✅ تم تشغيل Node.js'];
}
function stopServer(folder){const srv=db.servers[folder];if(!srv)return;if(children.has(folder)){try{process.kill(-children.get(folder).pid,'SIGTERM')}catch(_){try{children.get(folder).kill('SIGTERM')}catch(__){}}children.delete(folder);}else if(srv.pid){try{process.kill(srv.pid,'SIGTERM')}catch(_){} }srv.status='Stopped';srv.pid=null;startedAt.delete(folder);saveDB();}
function assignedPort(){const used=new Set(Object.values(db.servers).map(s=>s.port));for(let p=PORT_RANGE_START;p<PORT_RANGE_END;p++)if(!used.has(p))return p;return PORT_RANGE_START;}
function owned(req,folder){const email=sessionEmail(req),srv=db.servers[folder];return email&&srv&&srv.owner===email?srv:null;}
function fileSafe(name){return name && !name.includes('..') && !path.isAbsolute(name);}
async function notify(message){if(!BOT_TOKEN||!ADMIN_TELEGRAM_ID)return;try{await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:ADMIN_TELEGRAM_ID,text:message,parse_mode:'Markdown'})});}catch(_){} }

const app=express();
app.use(express.json({limit:'500mb'}));
app.use(express.urlencoded({extended:true,limit:'500mb'}));
const UPLOAD_DIR = path.join(RUNTIME_DIR,'.uploads');
fs.mkdirSync(UPLOAD_DIR,{recursive:true});
const upload=multer({dest:UPLOAD_DIR,limits:{fileSize:IS_VERCEL?4*1024*1024:500*1024*1024}});
app.get('/',(req,res)=>{const e=sessionEmail(req);res.redirect(e?(isAdmin(e)?'/admin':'/dashboard'):'/welcome');});
app.get('/welcome',(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'landing.html')));
app.get('/login',(req,res)=>sessionEmail(req)?res.redirect('/') : res.sendFile(path.join(PUBLIC_DIR,'login.html')));
app.get('/dashboard',(req,res)=>sessionEmail(req)?res.sendFile(path.join(PUBLIC_DIR,'index.html')):res.redirect('/login'));
app.get('/admin',(req,res)=>{const e=sessionEmail(req);res.sendFile(e&&isAdmin(e)?path.join(PUBLIC_DIR,'admin_panel.html'):path.join(PUBLIC_DIR,'login.html'));});

app.post('/api/register',(req,res)=>{if(!PUBLIC_REGISTRATION)return jsonFail(res,'التسجيل العام معطل مؤقتاً',503);const {email='',password=''}=body(req);const e=String(email).trim().toLowerCase(),p=String(password).trim();if(!e||!p)return jsonFail(res,'جميع الحقول مطلوبة');if(!e.includes('@')||!e.includes('.'))return jsonFail(res,'البريد الإلكتروني غير صالح');if(p.length<4)return jsonFail(res,'كلمة المرور قصيرة (4 أحرف على الأقل)');if(db.users[e]||e===ADMIN_EMAIL)return jsonFail(res,'هذا البريد مسجل بالفعل');const plan=db.plans.basic;db.users[e]={password:hash(p),is_admin:false,created_at:now(),max_servers:plan.max_servers,expiry_days:365,last_login:null,telegram_id:null,api_key:null,storage_limit:plan.storage,plan:'basic'};userDir(e);saveDB();notify(`🔔 *مستخدم جديد!*\n📧 \`${e}\`\n📅 ${now()}`);res.json({success:true,message:'✅ تم إنشاء حسابك! يمكنك تسجيل الدخول'});});
app.post('/api/login',(req,res)=>{const {email='',password=''}=body(req),e=String(email).trim().toLowerCase(),p=String(password).trim();if(e===ADMIN_EMAIL&&p===ADMIN_PASSWORD){db.users[ADMIN_EMAIL].last_login=now();saveDB();setSession(res,e);return res.json({success:true,redirect:'/admin',is_admin:true});}const u=db.users[e];if(u&&u.password===hash(p)){u.last_login=now();saveDB();setSession(res,e);return res.json({success:true,redirect:'/dashboard',is_admin:false});}res.json({success:false,message:'بيانات تسجيل الدخول غير صحيحة'});});
app.all('/api/logout',(req,res)=>{clearSession(req,res);res.json({success:true});});
app.get('/api/current_user',(req,res)=>{const e=sessionEmail(req),u=e&&db.users[e];res.json(u?{success:true,email:e,is_admin:u.is_admin||e===ADMIN_EMAIL,plan:u.plan||'basic'}:{success:false});});
app.post('/api/create_api_key',(req,res)=>{const e=apiAuth(req,res);if(!e)return;db.users[e].api_key=key();saveDB();res.json({success:true,api_key:db.users[e].api_key});});
app.post('/api/link_telegram',(req,res)=>{const e=apiAuth(req,res);if(!e)return;const id=String(body(req).telegram_id||'');if(!id)return jsonFail(res,'معرف تليجرام مطلوب');db.users[e].telegram_id=id;saveDB();res.json({success:true,message:'تم ربط حساب التليجرام'});});
app.get('/api/plans',(req,res)=>res.json({success:true,plans:db.plans}));
app.post('/api/user/upgrade',(req,res)=>{const e=apiAuth(req,res);if(!e)return;const id=body(req).plan_id;if(!db.plans[id])return jsonFail(res,'خطة غير موجودة');const p=db.plans[id];Object.assign(db.users[e],{plan:id,max_servers:p.max_servers,storage_limit:p.storage});saveDB();res.json({success:true,message:`✅ تم الترقية إلى ${p.name}`});});

app.get('/api/admin/users',(req,res)=>{if(!adminAuth(req,res))return jsonFail(res,'غير مصرح',403);res.json({success:true,users:Object.entries(db.users).map(([email,u])=>({username:email,email,is_admin:!!u.is_admin,created_at:u.created_at,last_login:u.last_login,max_servers:u.max_servers||1,expiry_days:u.expiry_days||365,telegram_id:u.telegram_id,api_key:u.api_key,storage_limit:u.storage_limit||102400,plan:u.plan||'basic'}))});});
app.post('/api/admin/create-user',(req,res)=>{if(!adminAuth(req,res))return jsonFail(res,'غير مصرح',403);const d=body(req),e=String(d.email||'').trim().toLowerCase(),p=String(d.password||'').trim();if(!e||!p)return jsonFail(res,'جميع الحقول مطلوبة');if(!e.includes('@')||!e.includes('.'))return jsonFail(res,'البريد الإلكتروني غير صالح');if(p.length<4)return jsonFail(res,'كلمة المرور قصيرة (4 أحرف على الأقل)');if(db.users[e])return jsonFail(res,'المستخدم موجود');db.users[e]={password:hash(p),is_admin:false,created_at:now(),max_servers:Number(d.max_servers||5),expiry_days:Number(d.expiry_days||365),last_login:null,telegram_id:null,api_key:null,storage_limit:102400,plan:'basic'};userDir(e);saveDB();res.json({success:true,message:'✅ تم إنشاء الحساب'});});
app.post('/api/admin/delete-user',(req,res)=>{if(!adminAuth(req,res))return jsonFail(res,'غير مصرح',403);const e=String(body(req).email||'').trim().toLowerCase();if(!e||e===ADMIN_EMAIL)return jsonFail(res,'لا يمكن حذف هذا المستخدم');if(!db.users[e])return jsonFail(res,'المستخدم غير موجود');for(const [f,s] of Object.entries(db.servers))if(s.owner===e){stopServer(f);fs.rmSync(s.path,{recursive:true,force:true});delete db.servers[f];}fs.rmSync(path.join(USERS_DIR,safeName(e)),{recursive:true,force:true});delete db.users[e];saveDB();res.json({success:true,message:`تم حذف ${e}`});});
app.post('/api/admin/update-user',(req,res)=>{if(!adminAuth(req,res))return jsonFail(res,'غير مصرح',403);const d=body(req),e=String(d.email||'').trim().toLowerCase(),u=db.users[e];if(!u)return jsonFail(res,'المستخدم غير موجود');for(const k of ['max_servers','expiry_days','storage_limit'])if(d[k]!==undefined)u[k]=Number(d[k]);if(d.is_admin!==undefined)u.is_admin=!!d.is_admin;saveDB();res.json({success:true,message:`✅ تم تحديث ${e}`});});
app.post('/api/admin/add-plan',(req,res)=>{if(!adminAuth(req,res))return jsonFail(res,'غير مصرح',403);const d=body(req),id=String(d.plan_id||d.name||'').toLowerCase().replace(/\s+/g,'_');if(!id)return jsonFail(res,'معرف الخطة مطلوب');if(db.plans[id])return jsonFail(res,'الخطة موجودة بالفعل');db.plans[id]={name:d.name||id,price:Number(d.price||0),storage:Number(d.storage||512000),ram:Number(d.ram||512),cpu:Number(d.cpu||.5),max_servers:Number(d.max_servers||5)};saveDB();res.json({success:true,message:'✅ تم إضافة الخطة'});});
app.get('/api/system/metrics',(req,res)=>{const total=os.totalmem(),free=os.freemem();let disk=0;try{const st=fs.statfsSync(BASE_DIR);disk=Math.round((1-(Number(st.bavail)/Number(st.blocks)))*100);}catch(_){}res.json({cpu:Math.min(100,Math.max(0,Math.round(os.loadavg()[0]*100/(os.cpus().length||1)))),memory:Math.round((1-free/total)*100),disk});});
app.all('/api/ping',(req,res)=>res.json({status:'pong',timestamp:now()}));

app.get('/api/admin/servers',(req,res)=>{if(!adminAuth(req,res))return jsonFail(res,'غير مصرح',403);const servers=Object.entries(db.servers).map(([folder,s])=>({folder,title:s.name,owner:s.owner,status:s.status||'Stopped',port:s.port||'N/A',plan:s.plan||'basic',created_at:s.created_at||'',disk_used:Number((dirSize(s.path)/1048576).toFixed(2))}));res.json({success:true,servers});});
app.get('/api/servers',(req,res)=>{const e=apiAuth(req,res);if(!e)return;const list=[];let total=0;for(const [folder,s] of Object.entries(db.servers)){if(s.owner!==e)continue;const used=dirSize(s.path)/1048576;total+=used;list.push({folder,title:s.name,type:'Node.js',startup_file:s.startup_file||'',status:s.status||'Stopped',uptime:s.status==='Running'?uptime(startedAt.get(folder)||s.start_time):'—',port:s.port||'N/A',plan:s.plan||'basic',storage_limit:s.storage_limit||102400,ram_limit:s.ram_limit||512,cpu_limit:s.cpu_limit||.5,disk_used:Number(used.toFixed(2))});}const u=db.users[e]||{};res.json({success:true,servers:list,stats:{used:list.length,total:u.max_servers||5,expiry:u.expiry_days||365,disk_used:Number(total.toFixed(2)),disk_total:u.storage_limit||102400}});});
app.post('/api/server/add',(req,res)=>{const e=apiAuth(req,res);if(!e)return;const u=db.users[e];if(!u)return jsonFail(res,'مستخدم غير موجود');if(Object.values(db.servers).filter(s=>s.owner===e).length>=(u.max_servers||5))return jsonFail(res,`وصلت للحد الأقصى (${u.max_servers||5}) سيرفر`);const d=body(req),name=String(d.name||'').trim();if(!name)return jsonFail(res,'أدخل اسماً للسيرفر');const planId=db.plans[d.plan]?(d.plan):(u.plan||'basic'),plan=db.plans[planId]||db.plans.basic,folder=`${safeName(e)}_${name.replace(/[^a-zA-Z0-9]/g,'')}_${stamp()}`,p=path.join(userDir(e),folder);fs.mkdirSync(p,{recursive:true});const port=assignedPort();db.servers[folder]={name,owner:e,path:p,type:'Node.js',status:'Stopped',created_at:now(),startup_file:'',pid:null,port,plan:planId,storage_limit:plan.storage,ram_limit:plan.ram,cpu_limit:plan.cpu};saveDB();res.json({success:true,message:`✅ تم إنشاء الخادم ${name}`,folder,port});});
app.post('/api/server/action/:folder/:action',(req,res)=>{const s=owned(req,req.params.folder);if(!s)return jsonFail(res,'غير مصرح',401);const f=req.params.folder,a=req.params.action;if(a==='start'){if(s.status==='Running')return jsonFail(res,'الخادم يعمل بالفعل');const [ok,msg]=startServer(f);return res.json({success:ok,message:msg});}if(a==='stop'){stopServer(f);return res.json({success:true,message:'🛑 تم الإيقاف'});}if(a==='restart'){stopServer(f);setTimeout(()=>startServer(f),500);return res.json({success:true,message:'🔄 جاري إعادة التشغيل'});}if(a==='delete'){stopServer(f);fs.rmSync(s.path,{recursive:true,force:true});delete db.servers[f];saveDB();return res.json({success:true,message:'🗑 تم الحذف'});}res.json({success:false,message:'إجراء غير معروف'});});
app.get('/api/server/stats/:folder',(req,res)=>{const s=owned(req,req.params.folder);if(!s)return jsonFail(res,'غير مصرح',401);const read=f=>{try{const a=fs.readFileSync(path.join(s.path,f),'utf8').split('\n');return a.slice(-500).join('\n');}catch(_){return ''}};let mem='0 MB';if(s.pid&&s.status==='Running'){try{mem=`${(process.memoryUsage().rss/1048576).toFixed(1)} MB`}catch(_){}}res.json({success:true,status:s.status,logs:read('out.log')||'لا توجد مخرجات بعد...',errors:read('errors.log').split('\n').slice(-50).join('\n'),mem,uptime:s.status==='Running'?uptime(startedAt.get(req.params.folder)||s.start_time):'—',port:s.port||'—',ip:publicIp(),type:'Node.js'});});

function serverOrEmpty(req,res){const s=owned(req,req.params.folder);if(!s){res.status(401).json([]);return null}return s;}
app.get('/api/files/list/:folder',(req,res)=>{const s=serverOrEmpty(req,res);if(!s)return;const skip=new Set(['out.log','server.log','meta.json','errors.log']);let files=[];try{files=fs.readdirSync(s.path).filter(n=>!skip.has(n)).map(n=>{const st=fs.statSync(path.join(s.path,n));return{name:n,size:sizeText(st.size),is_dir:st.isDirectory(),modified:new Date(st.mtime).toISOString().slice(0,16).replace('T',' '),is_zip:n.toLowerCase().endsWith('.zip')}}).sort((a,b)=>(b.is_dir-a.is_dir)||a.name.localeCompare(b.name));}catch(_){}res.json(files);});
function fileReq(req){const s=owned(req,req.params.folder);const name=req.fileName||req.params.filename;if(!s||!fileSafe(name))return null;return {s,name,p:path.join(s.path,name)};}
app.use('/api/files/content', (req,res,next)=>{req.fileName=req.path.replace(/^\//,'');next();});
app.get(/^\/api\/files\/content\/([^/]+)\/(.+)$/, (req,res)=>{const folder=req.params[0],name=req.params[1],s=owned(req,folder);if(!s||!fileSafe(name))return res.json({content:''});const p=path.join(s.path,name);if(!fs.existsSync(p)||fs.statSync(p).isDirectory())return res.json({content:''});try{res.json({content:fs.readFileSync(p,'utf8')});}catch(_){res.json({content:'[ملف ثنائي — لا يمكن عرضه]'});}});
app.use('/api/files/save', (req,res,next)=>{req.fileName=req.path.replace(/^\//,'');next();});
app.post(/^\/api\/files\/save\/([^/]+)\/(.+)$/, (req,res)=>{const folder=req.params[0],name=req.params[1],s=owned(req,folder);if(!s||!fileSafe(name))return jsonFail(res,'اسم غير صالح');const p=path.join(s.path,name);try{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body(req).content||'');res.json({success:true,message:'✅ تم الحفظ'});}catch(e){jsonFail(res,e.message);}});
app.post('/api/files/upload/:folder',upload.array('files[]'),(req,res)=>{const s=owned(req,req.params.folder);if(!s)return jsonFail(res,'غير مصرح',401);let n=0;for(const f of req.files||[]){if(fileSafe(f.originalname)){fs.renameSync(f.path,path.join(s.path,f.originalname));n++;}else fs.rmSync(f.path,{force:true});}res.json(n?{success:true,message:`✅ تم رفع ${n} ملف`}: {success:false,message:'فشل الرفع'});});
app.post('/api/files/rename/:folder',(req,res)=>{const s=owned(req,req.params.folder);if(!s)return jsonFail(res,'غير مصرح');const {old_name='',new_name=''}=body(req);if(!fileSafe(old_name)||!fileSafe(new_name))return jsonFail(res,'اسم غير صالح');const a=path.join(s.path,old_name),b=path.join(s.path,new_name);if(!fs.existsSync(a))return jsonFail(res,'الملف غير موجود');if(fs.existsSync(b))return jsonFail(res,'يوجد ملف بهذا الاسم');fs.renameSync(a,b);if(s.startup_file===old_name)s.startup_file=new_name;saveDB();res.json({success:true,message:`✅ تمت إعادة التسمية إلى ${new_name}`});});
app.post('/api/files/unzip/:folder/:filename',(req,res)=>{const folder=req.params.folder,name=req.params.filename,s=owned(req,folder);if(!s||!fileSafe(name))return jsonFail(res,'غير مصرح');try{const zipPath=path.join(s.path,name);if(!fs.existsSync(zipPath))return jsonFail(res,'الملف غير موجود');new AdmZip(zipPath).extractAllTo(s.path,true);res.json({success:true,message:`✅ تم فك ضغط ${name}`});}catch(e){jsonFail(res,'ملف ZIP غير صالح');}});
app.post('/api/files/delete/:folder',(req,res)=>{const s=owned(req,req.params.folder);if(!s)return jsonFail(res,'غير مصرح');let ns=body(req).names??body(req).name??[];if(typeof ns==='string')ns=[ns];let n=0;for(const x of ns)if(fileSafe(x)){const p=path.join(s.path,x);if(fs.existsSync(p)){fs.rmSync(p,{recursive:true,force:true});n++;}}res.json(n?{success:true,message:`🗑 تم حذف ${n} ملف`}:{success:false,message:'فشل الحذف'});});
app.post('/api/files/create/:folder',(req,res)=>{const s=owned(req,req.params.folder);if(!s)return jsonFail(res,'غير مصرح');const name=String(body(req).filename||'');if(!fileSafe(name))return jsonFail(res,'اسم غير صالح');const p=path.join(s.path,name);fs.mkdirSync(path.dirname(p),{recursive:true});if(fs.existsSync(p))return jsonFail(res,'الملف موجود بالفعل');fs.writeFileSync(p,body(req).content||'');res.json({success:true,message:`✅ تم إنشاء ${name}`});});
app.post('/api/server/set-startup/:folder',(req,res)=>{const s=owned(req,req.params.folder),f=body(req).filename;if(!s)return jsonFail(res,'غير مصرح');if(!fs.existsSync(path.join(s.path,f)))return jsonFail(res,'الملف غير موجود',404);s.startup_file=f;saveDB();res.json({success:true,message:`✅ تم تعيين ${f}`});});
app.post('/api/server/install/:folder',(req,res)=>{const s=owned(req,req.params.folder);if(!s)return jsonFail(res,'غير مصرح');if(!fs.existsSync(path.join(s.path,'package.json')))return jsonFail(res,'package.json غير موجود',404);const logPath=path.join(s.path,'out.log');fs.appendFileSync(logPath,`\n$ npm install --omit=dev\n`);const out=fs.openSync(logPath,'a');const p=spawn('npm',['install','--omit=dev'],{cwd:s.path,stdio:['ignore',out,out]});p.on('exit',(code)=>fs.appendFileSync(logPath,`\n📦 انتهى تثبيت المكتبات — code=${code}\n`));res.json({success:true,message:'📦 بدأ تثبيت حزم Node.js — ستظهر المخرجات في الكونسول',pid:p.pid});});

app.post('/api/bot/verify',(req,res)=>{const [e,u]=apiKeyUser(body(req).api_key);if(!body(req).api_key)return jsonFail(res,'API Key مطلوب');if(!e)return jsonFail(res,'API Key غير صالح');res.json({success:true,email:e,is_admin:isAdmin(e),max_servers:u.max_servers||5,expiry_days:u.expiry_days||365});});
app.get('/api/bot/servers',(req,res)=>{const [e]=apiKeyUser(req.query.api_key);if(!req.query.api_key)return jsonFail(res,'API Key مطلوب',401);if(!e)return jsonFail(res,'API Key غير صالح',401);res.json({success:true,servers:Object.entries(db.servers).filter(([,s])=>s.owner===e).map(([folder,s])=>({folder,title:s.name,status:s.status||'Stopped',uptime:s.status==='Running'?uptime(startedAt.get(folder)||s.start_time):'—',port:s.port||'N/A',plan:s.plan||'basic',type:'Node.js'}))});});
app.post('/api/bot/server/action',(req,res)=>{const d=body(req),[e]=apiKeyUser(d.api_key),s=db.servers[d.folder];if(!e)return jsonFail(res,'API Key غير صالح',401);if(!s||s.owner!==e)return jsonFail(res,'غير مصرح',403);if(d.action==='start'){const [ok,msg]=startServer(d.folder);return res.json({success:ok,message:msg});}if(d.action==='stop'){stopServer(d.folder);return res.json({success:true,message:'🛑 تم الإيقاف'});}if(d.action==='delete'){stopServer(d.folder);fs.rmSync(s.path,{recursive:true,force:true});delete db.servers[d.folder];saveDB();return res.json({success:true,message:'🗑 تم الحذف'});}res.json({success:true,message:'تم'});});
app.get('/api/bot/console',(req,res)=>botLog(req,res,'out.log','لا توجد مخرجات بعد'));
app.get('/api/bot/errors',(req,res)=>botLog(req,res,'errors.log','✅ لا توجد أخطاء'));
function botLog(req,res,file,empty){const [e]=apiKeyUser(req.query.api_key),s=db.servers[req.query.folder];if(!e)return jsonFail(res,'API Key غير صالح',401);if(!s||s.owner!==e)return jsonFail(res,'غير مصرح',403);let t='';try{t=fs.readFileSync(path.join(s.path,file),'utf8').split('\n').slice(-500).join('\n')}catch(_){}res.json({success:true,[file==='out.log'?'logs':'errors']:t||empty});}
app.post('/api/bot/install',(req,res)=>{const d=body(req),[e]=apiKeyUser(d.api_key),s=db.servers[d.folder];if(!e)return jsonFail(res,'API Key غير صالح',401);if(!s||s.owner!==e)return jsonFail(res,'غير مصرح',403);if(!fs.existsSync(path.join(s.path,'package.json')))return jsonFail(res,'package.json غير موجود',404);const logPath=path.join(s.path,'out.log');fs.appendFileSync(logPath,`\n$ npm install --omit=dev\n`);const out=fs.openSync(logPath,'a');const p=spawn('npm',['install','--omit=dev'],{cwd:s.path,stdio:['ignore',out,out]});p.on('exit',(code)=>fs.appendFileSync(logPath,`\n📦 انتهى تثبيت المكتبات — code=${code}\n`));res.json({success:true,message:'📦 بدأ تثبيت حزم Node.js'});});
app.post('/api/bot/create_server',(req,res)=>{const d=body(req),[e,u]=apiKeyUser(d.api_key);if(!e)return jsonFail(res,'API Key غير صالح',401);const name=String(d.name||'').trim();if(!name)return jsonFail(res,'API Key والاسم مطلوبان',400);if(Object.values(db.servers).filter(s=>s.owner===e).length>=(u.max_servers||5))return jsonFail(res,'وصلت للحد الأقصى');const p=db.plans[u.plan]||db.plans.basic,folder=`${safeName(e)}_${name.replace(/[^a-zA-Z0-9]/g,'')}_${stamp()}`,sp=path.join(userDir(e),folder);fs.mkdirSync(sp,{recursive:true});db.servers[folder]={name,owner:e,path:sp,type:'Node.js',status:'Stopped',created_at:now(),startup_file:'',pid:null,port:assignedPort(),plan:u.plan||'basic',storage_limit:p.storage,ram_limit:p.ram,cpu_limit:p.cpu};saveDB();res.json({success:true,message:`✅ تم إنشاء ${name}`,folder,port:db.servers[folder].port});});
app.post('/api/bot/set_startup',(req,res)=>{const d=body(req),[e]=apiKeyUser(d.api_key),s=db.servers[d.folder];if(!e)return jsonFail(res,'API Key غير صالح',401);if(!s||s.owner!==e)return jsonFail(res,'غير مصرح',403);if(!fs.existsSync(path.join(s.path,d.filename)))return jsonFail(res,'الملف غير موجود',404);s.startup_file=d.filename;saveDB();res.json({success:true,message:`✅ تم تعيين ${d.filename}`});});

app.use(express.static(PUBLIC_DIR,{index:false}));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({success:false,message:'خطأ داخلي في الخادم'});});
if(require.main===module)app.listen(PORT,'0.0.0.0',()=>console.log(`MS HOST Node.js running on 0.0.0.0:${PORT}`));
module.exports=app;

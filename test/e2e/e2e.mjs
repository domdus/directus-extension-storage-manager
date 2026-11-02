// End-to-end checks against a real Directus. Run with `npm run test:e2e`.
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';

const B = process.env.E2E_URL;
const UP = path.join(process.env.E2E_DATA, 'uploads');
let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
	condition ? pass++ : fail++;
	console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : `  -> ${JSON.stringify(detail).slice(0, 300)}`}`);
};
const j = async (method, url, body, headers = {}, token = T) => {
	const response = await fetch(B + url, {
		method,
		headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	return { s: response.status, d: data };
};
let T = null;
T = (await j('POST', '/auth/login', { email: 'admin@example.com', password: 'e2e-password' })).d.data.access_token;
const mk = async (collection, fields) => {
	const r = await j('POST', '/collections', { collection, schema: {}, meta: {}, fields });
	if (r.s !== 200) console.log('could not create', collection, JSON.stringify(r.d));
};
const uuidPk = { field: 'id', type: 'uuid', schema: { is_primary_key: true }, meta: { special: ['uuid'], hidden: true } };
const intPk = { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true }, meta: {} };

const up=async(name,body='x')=>{const f=new FormData();f.append('storage','local');f.append('file',new Blob([body]),name);const r=await fetch(B+'/files',{method:'POST',headers:{authorization:'Bearer '+T},body:f});return (await r.json()).data};
const place=async(fd,rel)=>{const dst=path.join(UP,rel);fs.mkdirSync(path.dirname(dst),{recursive:true,mode:0o777});fs.renameSync(path.join(UP,fd.filename_disk),dst);await j('PATCH','/files/'+fd.id,{filename_disk:rel});return fd.id};
const keep=await place(await up('k.txt','keep'),'video-files/k.txt'), cased=await place(await up('c.txt','keep'),'Video_files/c.txt'), del=await place(await up('d.txt','del'),'video_files/d.txt');
const sd=await j('DELETE','/storage-manager/storages/local/folders',{paths:['video_files'],mode:'delete'});
ok('sm: delete call ok',sd.s==200,sd);
ok('sm: target file deleted',(await j('GET','/files/'+del)).s!=200);
ok('sm: file in video-files survives',(await j('GET','/files/'+keep)).s==200);
ok('sm: file in Video_files survives',(await j('GET','/files/'+cased)).s==200);
ok('sm: disk file survives',fs.existsSync(path.join(UP,'video-files/k.txt')));
const m1=await up('m.txt','source-content');const diffTarget=path.join(UP,'..','uploads2',m1.filename_disk);fs.writeFileSync(diffTarget,'DIFFERENT!!!!!');
const mg=await j('POST','/storage-manager/migrate',{file_ids:[m1.id],target_storage:'abs',mode:'move'});
const r0=mg.d.data?.results?.[0]||mg.d;
ok('sm: migrate refuses different existing file',r0.status=='skipped'&&fs.existsSync(path.join(UP,m1.filename_disk))&&fs.readFileSync(diffTarget,'utf8')=='DIFFERENT!!!!!',mg);
ok('sm: DB still points at source',(await j('GET','/files/'+m1.id)).d.data.storage=='local');
fs.writeFileSync(diffTarget,'source-content');
const mg2=await j('POST','/storage-manager/migrate',{file_ids:[m1.id],target_storage:'abs',mode:'move'});
ok('sm: migrate adopts identical file',(mg2.d.data?.results?.[0]?.status)=='moved'&&(await j('GET','/files/'+m1.id)).d.data.storage=='abs',mg2);

// bulk scopes must not widen by wildcard or case
for (const [name, rel] of [['a.txt', 'scope/video_files/a.txt'], ['b.txt', 'scope/video-files/b.txt'], ['c.txt', 'scope/Video_files/c.txt'], ['d.txt', 'scope/video_files/deep/d.txt']]) await place(await up(name, name), rel);
const dry = (extra) => j('POST', '/storage-manager/migrate/dry-run', { source_storage: 'local', target_storage: 'abs', mode: 'copy', ...extra });
const byPath = await dry({ source_path: 'scope/video_files' });
ok('sm: source_path scope ignores wildcard and case', byPath.d.data?.total_files == 2, byPath);
const flat = await dry({ source_path: 'scope/video_files', recursive: false });
ok('sm: non-recursive scope stays in the folder', flat.d.data?.total_files == 1, flat);
const byFolder = await dry({ source_folders: ['scope/video_files'] });
ok('sm: source_folders scope ignores wildcard and case', byFolder.d.data?.total_files == 2, byFolder);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

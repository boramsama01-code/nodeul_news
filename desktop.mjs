import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const data = path.join(root, ".local");
mkdirSync(data, {recursive:true});
const controlFile = path.join(data, "control.json");
if (process.argv.includes("--stop")) {
  if (!existsSync(controlFile)) { console.log("Not running."); process.exit(0); }
  const {port, token} = JSON.parse(readFileSync(controlFile, "utf8"));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/stop`, {method:"POST",headers:{authorization:token}});
    if (!response.ok) throw new Error("Stop request rejected");
    console.log("Stopping Nodeul News...");
  } catch { console.error("Cannot contact the launcher. Check whether it is already closed."); process.exitCode=1; }
} else {
  await start();
}

async function start() {
  if (existsSync(controlFile)) {
    const previous = JSON.parse(readFileSync(controlFile, "utf8"));
    try {
      const response = await fetch(`http://127.0.0.1:${previous.port}/health`, {headers:{authorization:previous.token},signal:AbortSignal.timeout(1500)});
      if (response.ok) { console.log("Nodeul News is already running."); return; }
    } catch {}
  }
  if (!existsSync(".env")) copyFileSync(existsSync(".env.desktop.example") ? ".env.desktop.example" : ".env.example", ".env");
  process.loadEnvFile(".env");
  const secretPath = path.join(data,"database-password");
  if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString("hex"), {flag:"wx"});
  const password = readFileSync(secretPath,"utf8").trim();
  const dbPort = Number(process.env.LOCAL_DB_PORT || 55432);
  const webPort = Number(process.env.WEB_PORT || 8080);
  for (const port of [dbPort,webPort]) if (!Number.isInteger(port) || port<1 || port>65535) throw new Error("Invalid port");
  const pg = name => path.join(root,"runtime","postgres","bin",`${name}.exe`);
  const databaseDir = path.join(data,"postgres");
  const run = (executable,args,env=process.env) => {
    const result=spawnSync(executable,args,{cwd:root,env,stdio:"inherit",windowsHide:true});
    if (result.error || result.status !== 0) throw result.error || new Error(`${path.basename(executable)} exited with ${result.status}`);
  };
  if (!existsSync(path.join(databaseDir,"PG_VERSION"))) {
    run(pg("initdb"),["-D",databaseDir,"-U","nodeul","--auth=scram-sha-256","--encoding=UTF8","--locale=C",`--pwfile=${secretPath}`]);
  }
  const status=spawnSync(pg("pg_ctl"),["-D",databaseDir,"status"],{stdio:"ignore",windowsHide:true});
  if (status.status !== 0) run(pg("pg_ctl"),["-D",databaseDir,"-l",path.join(data,"postgres.log"),"-o",`-h 127.0.0.1 -p ${dbPort}`,"-w","start"]);
  const env={...process.env,NODE_ENV:"production",HOST:"127.0.0.1",PORT:String(webPort),DATA_DIR:data,WEB_DIST:path.join(root,"public"),RUN_SCHEDULER:"false"};
  env.DATABASE_URL=`postgresql://nodeul:${password}@127.0.0.1:${dbPort}/postgres`;
  run(process.execPath,["dist/setup.mjs","--create-database"],env);
  env.DATABASE_URL=`postgresql://nodeul:${password}@127.0.0.1:${dbPort}/nodeul_news`;
  run(process.execPath,["dist/setup.mjs","--schema"],env);
  const seed=path.join(root,"backup","nodeulnews_data.sql");
  const seedMarker=path.join(data,"upstream-imported");
  if(existsSync(seed) && !existsSync(seedMarker)) {
    run(process.execPath,["dist/setup.mjs","--import",seed],env);
    writeFileSync(seedMarker,new Date().toISOString());
  }
  if (process.argv.includes("--import")) {
    const file=process.argv[process.argv.indexOf("--import")+1];
    if (!file) throw new Error("Provide a SQL backup path after --import");
    run(process.execPath,["dist/setup.mjs","--import",file],env);
  }
  // Automatic daily article backup, including manual edits and trash flags.
  const backups=path.join(data,"backups");
  mkdirSync(backups,{recursive:true});
  const backup=()=>{
    const file=path.join(backups,`articles-${new Date().toISOString().slice(0,10)}.sql`);
    if (!existsSync(file)) run(process.execPath,["dist/setup.mjs","--backup",file],env);
  };
  backup();
  const backupTimer=setInterval(()=>{try{backup();}catch(err){console.error("Backup failed:",err.message);}},3600_000);
  const children=[];
  let closing=false;
  const token=randomBytes(32).toString("hex");
  const control=createServer((req,res)=>{
    if (req.headers.authorization!==token) {res.writeHead(403).end();return;}
    if(req.url==="/stop" && req.method==="POST") {res.end("Stopping");void stop();}
    else if(req.url==="/health") res.end("ok");
    else res.writeHead(404).end();
  });
  await new Promise(resolve=>control.listen(0,"127.0.0.1",resolve));
  writeFileSync(controlFile,JSON.stringify({port:control.address().port,token}));
  async function stop() {
    if(closing)return;
    closing=true;
    clearInterval(backupTimer);
    for(const child of children) child.kill();
    await Promise.all(children.map(child=>child.exitCode!==null ? Promise.resolve() : new Promise(resolve=>child.once("exit",resolve))));
    try { backup(); } catch(err) {console.error(err.message);}
    try { run(pg("pg_ctl"),["-D",databaseDir,"-m","fast","-w","stop"]); } catch(err) {console.error(err.message);}
    control.close();
    if(existsSync(controlFile)) unlinkSync(controlFile);
  }
  process.on("SIGINT",()=>void stop());
  process.on("SIGTERM",()=>void stop());
  for(const name of process.env.DISABLE_WORKER==="true" ? ["index"] : ["index","worker"]) {
    const child=spawn(process.execPath,[`dist/${name}.mjs`],{cwd:root,env,stdio:["ignore","inherit","inherit"],windowsHide:true});
    children.push(child);
    child.on("error",err=>{console.error(err);void stop();});
    child.on("exit",code=>{if(!closing){console.error(`${name} stopped (${code}); stopping application.`);process.exitCode=1;void stop();}});
  }
  console.log(`Nodeul News: http://localhost:${webPort}\nKeep this launcher running. Use stop-windows.cmd to stop safely.`);
  let ready=false;
  for(let attempt=0;attempt<40 && !closing;attempt++) {
    try { const response=await fetch(`http://127.0.0.1:${webPort}/api/healthz`,{signal:AbortSignal.timeout(1000)}); if(response.ok || response.status===401){ready=true;break;} } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready){console.error("Web service did not become ready.");await stop();return;}
  if(process.env.NO_BROWSER!=="true") {
    // Open only a fixed local URL. No shell expansion of user input.
    spawn("explorer.exe",[`http://localhost:${webPort}`],{windowsHide:true,stdio:"ignore"}).unref();
  }
}

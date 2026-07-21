import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { canonicalize, sha256Bytes } from './contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeContract = Object.freeze(JSON.parse(
  readFileSync(join(here, 'merge.raster-runtime-contract.v1.json'), 'utf8'),
));
const qaGate = Object.freeze(JSON.parse(
  readFileSync(join(here, 'merge.catalog-artifact-qa-gate.v1.json'), 'utf8'),
));

function sha256Jcs(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function exactHash(value, label) {
  if (!/^[0-9a-f]{64}$/.test(String(value || ''))) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hash`);
  }
  return String(value);
}

function exactDigest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value || ''))) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
  return String(value);
}

function exactCommit(value, label) {
  if (!/^[0-9a-f]{40}$/.test(String(value || ''))) {
    throw new TypeError(`${label} must be a lowercase git commit`);
  }
  return String(value);
}

export const mergeRasterRuntimeContract = runtimeContract;
export const mergeRasterRuntimeContractDigest = sha256Jcs(runtimeContract);
export const mergeRasterQaGate = qaGate;
export const mergeRasterQaGateDigest = `sha256:${sha256Jcs(qaGate)}`;

export function mergeRasterVariant(artPackHash) {
  return `raster-art-${exactHash(artPackHash, 'artPackHash').slice(0, 12)}`;
}

export function mergeRasterLevelSpec(candidate, sourceQa) {
  exactCommit(candidate.baseCommit, 'baseCommit');
  if (sourceQa?.schema !== 'merge.art-qa-report.v1') throw new TypeError('sourceQa must be a Merge art QA report');
  const identity = {
    schema: 'merge.raster-level-spec.v1',
    runtimeContractDigest: mergeRasterRuntimeContractDigest,
    seed: 0,
    params: {
      artifactClass: 'merge-raster-art-v1',
      artPackHash: exactHash(candidate.artPackHash, 'artPackHash'),
      sourceRuntimeArtifactDigest: exactDigest(candidate.runtimeArtifactDigest, 'runtimeArtifactDigest'),
      sourceHtmlSha256: exactDigest(candidate.htmlSha256, 'htmlSha256'),
      templateContractDigest: exactHash(candidate.templateContractDigest, 'templateContractDigest'),
      compilerDigest: exactHash(candidate.compilerDigest, 'compilerDigest'),
      providerPolicyDigest: exactHash(candidate.providerPolicyDigest, 'providerPolicyDigest'),
      qaReportDigest: exactDigest(candidate.qa?.reportDigest, 'qa.reportDigest'),
      sourceQaEvidenceHash: sha256Jcs(sourceQa),
      gameplayFingerprint: sha256Jcs({
        schema: 'merge.raster-gameplay-fingerprint.v1',
        baselineId: candidate.baselineId,
        baseCommit: candidate.baseCommit,
      }),
      presentationFingerprint: sha256Jcs({
        schema: 'merge.raster-presentation-fingerprint.v1',
        artPackHash: candidate.artPackHash,
      }),
    },
  };
  return Object.freeze({ ...identity, specHash: sha256Jcs(identity) });
}

function runtimeHtml({ candidate, sourceQa, innerHtmlBase64, runtimeArtifactDigest }) {
  const spec = mergeRasterLevelSpec(candidate, sourceQa);
  const embedded = JSON.stringify({
    artPackHash: candidate.artPackHash,
    sourceHtmlSha256: candidate.htmlSha256,
    runtimeContractDigest: mergeRasterRuntimeContractDigest,
    runtimeArtifactDigest,
    specHash: spec.specHash,
  });
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; frame-src blob:; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:">
<style>html,body,#mount,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden;background:#111}iframe{visibility:hidden}iframe[data-ready="true"]{visibility:visible}#failure{display:none;position:fixed;inset:0;z-index:9;place-items:center;background:#2f3650;color:#fff;font:700 18px/1.3 system-ui}</style>
</head><body><div id="mount"></div><div id="failure">World unavailable</div><script>(()=>{
'use strict';
const E=${embedded};
const B='${innerHtmlBase64}';
const qs=new URL(location.href).searchParams;
const parentOrigin=(()=>{try{const value=new URL(document.referrer).origin;return value&&value!=='null'?value:null}catch{return null}})();
const failure=document.getElementById('failure');
const fail=(reason)=>{try{if(parentOrigin)parent.postMessage({type:'configure_failed',reason},parentOrigin)}catch{}failure.style.display='grid'};
if(!parentOrigin){fail('origin');return}
if(qs.get('level_config')!=='catalog_required'||!(/^[0-9a-f]{64}$/).test(qs.get('expected_spec_hash')||'')){fail('digest');return}
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join('\\0')===k.slice().sort().join('\\0');
const canon=(v)=>{if(v===null)return'null';if(typeof v==='string')return JSON.stringify(v);if(typeof v==='number'){if(!Number.isFinite(v))throw new Error('number');return JSON.stringify(v)}if(typeof v==='boolean')return v?'true':'false';if(Array.isArray(v))return'['+v.map(canon).join(',')+']';if(typeof v==='object')return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';throw new Error('type')};
const hex=async(v)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canon(v))))).map(x=>x.toString(16).padStart(2,'0')).join('');
const nonce=Array.from(crypto.getRandomValues(new Uint8Array(16))).map(x=>x.toString(16).padStart(2,'0')).join('');
let terminal=false,child=null,configured=false;
const forward=(data)=>{try{parent.postMessage(data,parentOrigin)}catch{}};
const timer=setTimeout(()=>{if(!terminal){terminal=true;fail('timeout')}},15000);
addEventListener('message',async(ev)=>{
  if(child&&ev.source===child.contentWindow){
    const data=ev.data;
    if(data&&typeof data==='object'&&data.source==='playable'){
      if(!configured&&(data.type==='static_ready'||data.type==='interactive_ready'||data.type==='ready')){
        configured=true;terminal=true;clearTimeout(timer);child.dataset.ready='true';
        forward({type:'configured',appliedSpecHash:E.specHash,runtimeContractDigest:E.runtimeContractDigest,runtimeArtifactDigest:E.runtimeArtifactDigest});
      }
      if(configured)forward(data);
    }
    return;
  }
  if(ev.source!==parent||ev.origin!==parentOrigin)return;
  const data=ev.data;
  if(data&&typeof data==='object'&&data.target==='playable-swipe'&&child&&configured){child.contentWindow.postMessage(data,'*');return}
  if(terminal||data?.type!=='configure_level')return;
  try{
    if(!exact(data,['type','nonce','spec'])||data.nonce!==nonce)throw new Error('wire');
    const specValue=data.spec;
    if(!exact(specValue,['schema','specHash','runtimeContractDigest','seed','params'])||specValue.schema!=='merge.raster-level-spec.v1'||specValue.runtimeContractDigest!==E.runtimeContractDigest||specValue.seed!==0||!exact(specValue.params,['artifactClass','artPackHash','sourceRuntimeArtifactDigest','sourceHtmlSha256','templateContractDigest','compilerDigest','providerPolicyDigest','qaReportDigest','sourceQaEvidenceHash','gameplayFingerprint','presentationFingerprint'])||specValue.params.artifactClass!=='merge-raster-art-v1'||specValue.params.artPackHash!==E.artPackHash||specValue.params.sourceHtmlSha256!==E.sourceHtmlSha256||await hex({schema:specValue.schema,runtimeContractDigest:specValue.runtimeContractDigest,seed:specValue.seed,params:specValue.params})!==specValue.specHash||specValue.specHash!==E.specHash||specValue.specHash!==qs.get('expected_spec_hash'))throw new Error('spec');
    const bytes=Uint8Array.from(atob(B),char=>char.charCodeAt(0));
    const digest='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
    if(digest!==E.sourceHtmlSha256)throw new Error('inner');
    child=document.createElement('iframe');child.setAttribute('sandbox','allow-scripts');child.src=URL.createObjectURL(new Blob([bytes],{type:'text/html'}));document.getElementById('mount').appendChild(child);
  }catch{terminal=true;clearTimeout(timer);fail('contract')}
});
forward({type:'configure_ready',nonce,runtimeContractDigest:E.runtimeContractDigest,runtimeArtifactDigest:E.runtimeArtifactDigest});
})()</script></body></html>`;
}

function command(commandName, args, cwd) {
  const result = spawnSync(commandName, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`merge_catalog_runtime_command_failed: ${(result.stderr || result.stdout || '').slice(-8000)}`);
  }
}

export function buildMergeCatalogRuntime({
  candidateFile,
  htmlFile,
  sourceQaFile,
  outputRoot,
  playablesRepo,
  sourceCommit,
} = {}) {
  const candidate = JSON.parse(readFileSync(resolve(String(candidateFile || '')), 'utf8'));
  if (candidate.schema !== 'merge.art-lab-candidate.v1'
    || candidate.artifactClass !== 'merge-raster-art-v1'
    || candidate.autoplayPassed !== true) {
    throw new TypeError('merge_catalog_candidate_invalid');
  }
  const html = readFileSync(resolve(String(htmlFile || '')));
  if (html.length < 1 || html.length > 16 * 1024 * 1024) throw new Error('merge_catalog_candidate_html_size');
  if (`sha256:${sha256Bytes(html)}` !== candidate.htmlSha256) {
    throw new Error('merge_catalog_candidate_html_mismatch');
  }
  const sourceQaBytes = readFileSync(resolve(String(sourceQaFile || '')));
  if (`sha256:${sha256Bytes(sourceQaBytes)}` !== candidate.qa?.reportDigest) {
    throw new Error('merge_catalog_source_qa_digest_mismatch');
  }
  const sourceQa = JSON.parse(sourceQaBytes.toString('utf8'));
  const commit = exactCommit(sourceCommit, 'sourceCommit');
  const spec = mergeRasterLevelSpec(candidate, sourceQa);
  const root = resolve(String(outputRoot || ''));
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, `.staging-${spec.specHash}-`));
    const runtimeRoot = join(staging, 'runtime');
    const evidenceRoot = join(staging, 'evidence');
    mkdirSync(runtimeRoot);
    mkdirSync(evidenceRoot);
  try {
    const placeholder = `sha256:${'0'.repeat(64)}`;
    writeFileSync(
      join(runtimeRoot, 'index.html'),
      runtimeHtml({ candidate, sourceQa, innerHtmlBase64: html.toString('base64'), runtimeArtifactDigest: placeholder }),
      { flag: 'wx' },
    );
    const playables = resolve(String(playablesRepo || ''));
    command(
      'node',
      [join(playables, 'scripts', 'stamp-runtime-artifact.mjs'), runtimeRoot, 'merge-locked-v1-swipe', commit],
      playables,
    );
    const sidecar = JSON.parse(readFileSync(join(runtimeRoot, 'runtime-artifact.json'), 'utf8'));
    const manifest = {
      schema: 'merge.catalog-runtime-artifact.v1',
      artPackHash: candidate.artPackHash,
      variant: mergeRasterVariant(candidate.artPackHash),
      sourceCandidateId: candidate.id,
      sourceHtmlSha256: candidate.htmlSha256,
      sourceRuntimeArtifactDigest: candidate.runtimeArtifactDigest,
      sourceCommit: commit,
      runtimeContractDigest: mergeRasterRuntimeContractDigest,
      runtimeArtifactDigest: sidecar.digest,
      qaGateDigest: mergeRasterQaGateDigest,
      levelSpec: spec,
      indexPath: 'runtime/index.html',
      sidecarPath: 'runtime/runtime-artifact.json',
      sourceQaPath: 'evidence/source-qa.json',
      adapterQaPath: 'evidence/adapter-qa.json',
      capabilities: { catalogRequiredHandshake: true, mergeRasterArtV1: true },
    };
    writeFileSync(join(evidenceRoot, 'source-qa.json'), sourceQaBytes, { flag: 'wx' });
    writeFileSync(join(staging, 'catalog-runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    const finalRoot = join(root, sidecar.digest.slice('sha256:'.length));
    try {
      renameSync(staging, finalRoot);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      const committed = JSON.parse(readFileSync(join(finalRoot, 'catalog-runtime.json'), 'utf8'));
      if (canonicalize(committed) !== canonicalize(manifest)) {
        throw new Error('merge_catalog_runtime_conflict');
      }
      if (!readFileSync(join(finalRoot, manifest.sourceQaPath)).equals(sourceQaBytes)) {
        throw new Error('merge_catalog_runtime_source_qa_conflict');
      }
      return committed;
    }
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

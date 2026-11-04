import {spawn} from 'node:child_process';
import {readSecret} from './secure-input.mjs';
const {key}=await readSecret();
const child=spawn(process.execPath,['scripts/run-framework.mjs','dev'],{env:{...process.env,ORDERDESK_KEY:key},stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exit(code??0));

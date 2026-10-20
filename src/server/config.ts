import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
export function readConfig(){
 if(existsSync('.env'))process.loadEnvFile('.env');
 const dataDir=resolve(process.env.HARNESS_DATA_DIR??'.data');
 const port=Number(process.env.PORT??4317);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid_port');
 return {dataDir,databasePath:join(dataDir,'harness.db'),workspace:resolve(process.env.HARNESS_WORKSPACE??join(dataDir,'workspace')),authDir:resolve(process.env.PI_AUTH_DIR??join(dataDir,'auth')),verificationPath:join(dataDir,'subscription-verification.json'),model:process.env.PI_MODEL??'gpt-5.5',port};
}

import { defineConfig } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dataDir=mkdtempSync(join(tmpdir(),'harness-browser-'));
export default defineConfig({
 testDir:'./tests',testMatch:'ui.spec.ts',fullyParallel:false,workers:1,timeout:15000,
 use:{baseURL:'http://127.0.0.1:4318',trace:'retain-on-failure',launchOptions:{executablePath:process.env.CHROMIUM_PATH??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined)}},
 webServer:[
  {command:'npm start',url:'http://127.0.0.1:4318/api/health',env:{PORT:'4318',HARNESS_DATA_DIR:dataDir,PI_AUTH_DIR:join(dataDir,'auth')},reuseExistingServer:false},
  {command:'npx tsx tests/fixtures/browser-server.ts',url:'http://127.0.0.1:4319/api/health',reuseExistingServer:false},
 ],
});

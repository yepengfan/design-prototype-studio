import { e2eFixture } from "../e2e-fixture";
import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createServer as createViteServer} from 'vite';
import {createApp} from '../../server/app';
import {registryFixture} from '../registry';
import {prototypeFixture} from '../prototype';
import {exportArchive} from '../../server/core/archive';
import {accountFreeAI} from '../account-free-ai';

test('real delivery report is retained for unchanged revision and disappears after review or remapping', async ({page})=>{
 test.setTimeout(360000);
 const root=await e2eFixture('live-quality-');
 const registry=await registryFixture(root);
 const prior=process.env.npm_config_userconfig;
 process.env.npm_config_userconfig=registry.config;
 const server=createServer();
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const studio=await createApp({root:path.join(root,'studio'),origin,ai:accountFreeAI});
 const vite=await createViteServer({server:{middlewareMode:true,hmr:false},appType:'spa'});
 studio.app.use(vite.middlewares);server.on('request',studio.app);
 try {
 const prototype=await prototypeFixture(path.join(root,'original'),registry.base);
 const secret=(await (await fetch(origin+'/api/session')).json()).secret;
 const response=await fetch(origin+'/api/import',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Session':secret},body:JSON.stringify({archive:exportArchive(prototype.files,prototype.manifest).toString('base64'),confirm:true})});
 expect(response.ok).toBeTruthy();const imported=await response.json();
 const initial=await (await fetch(origin+`/api/projects/${imported.state.id}`,{headers:{'X-Studio-Session':secret}})).json();
 const scenario=initial.scope.scenarios[0];
 await page.addInitScript(id=>localStorage.setItem('studio-project',id),imported.state.id);
 await page.goto(origin);
 await page.getByRole('button',{name:'Check delivery',exact:true}).click();
 const green=page.getByRole('heading',{name:'Automatic checks passed. Designer review remains.'});
 const check=async()=>{await page.getByRole('button',{name:'Run deliverability checks'}).click();await expect(green).toBeVisible({timeout:180000});};
 await check();
 await page.screenshot({path:test.info().outputPath('quality-current.png'),fullPage:true});
 await page.getByRole('button',{name:'Choose existing scenario stories'}).click();
 await expect(green).toBeVisible();
 const plan=page.locator('.scenario-plan').filter({has:page.locator('summary').filter({hasText:scenario.name})});
 await plan.locator('summary').click();
 await Promise.all([
 page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith(`/scenarios/${scenario.id}/review`)&&response.ok()),
 plan.getByRole('button',{name:'Reopen test plan review'}).click(),
 ]);
 await expect(green).toHaveCount(0);
 await expect(plan.locator('summary')).toContainText('Review needed');
 await page.screenshot({path:test.info().outputPath('quality-review-invalidated.png'),fullPage:true});
 if(!await plan.getByRole('button',{name:'These checks match the scenario'}).isVisible())await plan.locator('summary').click();
 await Promise.all([
 page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith(`/scenarios/${scenario.id}/review`)&&response.ok()),
 plan.getByRole('button',{name:'These checks match the scenario'}).click(),
 ]);
 await expect(plan.locator('summary')).toContainText('Test plan reviewed');
 await check();
 await page.getByRole('button',{name:'Choose existing scenario stories'}).click();
 if(!await plan.getByLabel('Original story').isVisible())await plan.locator('summary').click();
 await plan.getByLabel('Original story').selectOption('src/Notice.stories.tsx#Replacement');
 await Promise.all([
 page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith(`/scenarios/${scenario.id}/map`)&&response.ok()),
 plan.getByRole('button',{name:'Map this scenario to this story'}).click(),
 ]);
 await expect(page.locator('.progress')).toHaveCount(0,{timeout:150000});
 await expect(green).toHaveCount(0);
 await expect(plan.locator('summary')).toContainText('Review needed');
 await page.screenshot({path:test.info().outputPath('quality-remap-invalidated.png'),fullPage:true});
 const current=await (await fetch(origin+`/api/projects/${imported.state.id}`,{headers:{'X-Studio-Session':secret}})).json();
 expect(current.snapshot.id).not.toBe(imported.snapshot.id);
 const remapped=current.snapshot.manifest.scenarios.find((binding:any)=>binding.scenario===scenario.id);
 expect(remapped).toBeDefined();
 expect(remapped.accepted).toBe(false);
 expect(remapped.story).toBe('src/Notice.stories.tsx#Replacement');
 await fs.writeFile(test.info().outputPath('quality-state.json'),JSON.stringify({original:imported.snapshot.id,current:current.snapshot.id,binding:remapped},null,2));
 }finally{await studio.close();await vite.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await registry.close();if(prior===undefined)delete process.env.npm_config_userconfig;else process.env.npm_config_userconfig=prior;await fs.rm(root,{recursive:true,force:true});}
});

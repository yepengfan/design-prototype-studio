import { blankProject, synchronizeRuntime } from "../server/core/project";
import { parseRequirements } from "../server/core/requirements";
import { installProject, inspectLibrary } from "../server/core/libraries";
export async function prototypeFixture(root: string, registry: string) {
  const p = blankProject("Notice acknowledgement");
  p.manifest.generationState = "generated";
  p.manifest.provider = "src/providers.tsx#ThemeProvider";
  p.files["src/providers.tsx"] =
    `import {createContext,type ReactNode} from 'react'; export const Theme=createContext('No theme'); export function ThemeProvider({children}:{children:ReactNode}){return <Theme.Provider value="Notice workspace">{children}</Theme.Provider>}`;
  p.files["src/data/notices.ts"] =
    `import {adapterFromHandlers,type DataAdapter} from './adapter';
export type Queries={notice:{input:undefined;output:{title:string}|null}};export type Operations={acknowledge:{input:{name:string};output:{ok:boolean}}};export type NoticeAdapter=DataAdapter<Queries,Operations>;
export const success=adapterFromHandlers<Queries,Operations>({notice:()=>({title:'A studio notice'})},{acknowledge:()=>({ok:true})});
export const failure=adapterFromHandlers<Queries,Operations>({notice:()=>({title:'A studio notice'})},{acknowledge:()=>({ok:false})});
export const empty=adapterFromHandlers<Queries,Operations>({notice:()=>null},{acknowledge:()=>({ok:false})});
export const replacement:NoticeAdapter={query:async()=>({title:'A studio notice'}),operate:async()=>({ok:true})};`;
  p.files["src/pages/Page.tsx"] =
    `import {useState,useEffect,useContext,type FormEvent} from 'react';import {Button,Input} from '@studio-test/controls';import {Card} from '@studio-test/layout';import {success,type NoticeAdapter} from '../data/notices';import {Theme} from '../providers';
export function Page({adapter=success}:{adapter?:NoticeAdapter}){const theme=useContext(Theme);const[name,setName]=useState('');const[notice,setNotice]=useState<{title:string}|null|undefined>();const[status,setStatus]=useState('');const[error,setError]=useState('');useEffect(()=>{let active=true;adapter.query('notice',undefined).then(value=>{if(active)setNotice(value)});return()=>{active=false}},[adapter]);async function submit(event:FormEvent){event.preventDefault();setError('');setStatus('');if(!name.trim()){setError('Name is required');return}const result=await adapter.operate('acknowledge',{name:name.trim()});if(result.ok)setStatus('Acknowledged '+name.trim());else setError('Please try again')}
return <main style={{padding:40,maxWidth:760,margin:'auto'}}><h1>{theme}</h1><Card tone="accent"><h2>{notice===undefined?'Loading':notice?.title??'No notice'}</h2><form onSubmit={submit}><label>Your name<Input aria-label="Your name" value={name} placeholder="Your name" onChange={event=>setName(event.target.value)}/></label><Button type="submit" disabled={!notice}>Acknowledge</Button></form><p role="status" aria-label="Acknowledgement">{status}</p>{error&&<p role="alert">{error}</p>}</Card></main>}`;
  p.files["src/styles.css"] =
    "body{font:16px/1.6 system-ui;background:#f7f9f4;color:#243f30}input{padding:10px;border:1px solid #b6c7ad;border-radius:4px;margin:8px 0;display:block}button{padding:10px 16px;background:#286b55;color:white;border:0;border-radius:5px}button:disabled{opacity:.4}form{margin:20px 0}";
  p.manifest.styles = ["@studio-test/layout/tokens.css", "src/styles.css"];
  p.files[".storybook/base-preview.tsx"] =
    'import "../src/styles.css"; export default {parameters:{layout:"fullscreen"}};';
  p.files["src/Notice.stories.tsx"] =
    `import type {Meta,StoryObj} from '@storybook/react-vite';import {Page} from './pages/Page';import {success,failure,empty,replacement} from './data/notices';
const meta={title:'Notices/Acknowledgement',component:Page,decorators:[Story=><section className="story-frame"><Story/></section>]} satisfies Meta<typeof Page>;export default meta;type Story=StoryObj<typeof meta>;
export const Success:Story={args:{adapter:success}};export const Validation:Story={render:()=> <Page adapter={success}/>};export const Failure:Story={args:{adapter:failure}};export const Empty:Story={render:()=> <Page adapter={empty}/>};export const Replacement:Story={args:{adapter:replacement}};`;
  p.files["requirements/notices.feature"] = `Feature: Acknowledge a notice
  Background:
    Given the notice workspace is open
  Scenario: Successful acknowledgement
    Given a notice is available
    When I enter Alex as my name
    And I acknowledge the notice
    Then I see Acknowledged Alex
  Scenario: Required name
    Given a notice is available
    When I acknowledge without a name
    Then I see Name is required
  Scenario: Failed acknowledgement
    Given a notice is available
    When I enter Alex as my name
    And I acknowledge the notice
    Then I see Please try again
  Scenario: No notice
    Given no notice is available
    Then acknowledgement is disabled
`;
  p.manifest.scope = ["requirements"];
  const parsed = parseRequirements(p.files, p.manifest.scope);
  const names = ["Success", "Validation", "Failure", "Empty"];
  p.manifest.scenarios = parsed.scenarios.map((s, i) => ({
    scenario: s.id,
    page: "page",
    story: "src/Notice.stories.tsx#" + names[i],
    fixture: "src/data/notices.ts",
    accepted: true,
    steps: s.steps.map((step) => {
      if (step.text === "the notice workspace is open")
        return {
          step: step.id,
          action: "visible" as const,
          role: "heading",
          name: "Notice workspace",
        };
      if (step.text === "a notice is available")
        return {
          step: step.id,
          action: "visible" as const,
          role: "heading",
          name: "A studio notice",
        };
      if (step.text === "no notice is available")
        return {
          step: step.id,
          action: "visible" as const,
          role: "heading",
          name: "No notice",
        };
      if (step.text.includes("enter Alex"))
        return {
          step: step.id,
          action: "fill" as const,
          role: "textbox",
          name: "Your name",
          value: "Alex",
        };
      if (step.text.startsWith("I acknowledge"))
        return {
          step: step.id,
          action: "click" as const,
          role: "button",
          name: "Acknowledge",
        };
      if (step.text === "acknowledgement is disabled")
        return {
          step: step.id,
          action: "disabled" as const,
          role: "button",
          name: "Acknowledge",
        };
      if (step.text === "I see Acknowledged Alex")
        return {
          step: step.id,
          action: "text" as const,
          role: "status",
          name: "Acknowledgement",
          value: "Acknowledged Alex",
        };
      return {
        step: step.id,
        action: "text" as const,
        role: "alert",
        name: "",
        value: step.text.replace("I see ", ""),
      };
    }),
  }));
  const pkg = JSON.parse(p.files["package.json"]);
  pkg.dependencies["@studio-test/controls"] = "1.0.0";
  pkg.dependencies["@studio-test/layout"] = "1.0.0";
  p.files["package.json"] = JSON.stringify(pkg, null, 2);
  const registries = [
    { name: "@studio-test/controls", registry },
    { name: "@studio-test/layout", registry },
  ];
  p.files["package-lock.json"] = await installProject(
    root,
    p.files,
    registries,
  );
  for (const lib of registries) {
    const admitted = await inspectLibrary(root, lib.name, "1.0.0");
    p.manifest.libraries.push({
      ...lib,
      version: "1.0.0",
      components: admitted.components,
    });
  }
  p.files = synchronizeRuntime(p.files, p.manifest);
  return p;
}

import { createImpactReport, getConnectedProject, listProjectEdges, listProjectFiles } from "./store";
import { runProjectGit } from "./scanner";
import type { ProjectImpactReport } from "./types";

function safeRef(value: string | null | undefined): string | null {
  const ref = value?.trim();
  if (!ref) return null;
  if (!/^[A-Za-z0-9._/@+-]{1,200}$/.test(ref) || ref.startsWith("-")) throw new Error("Invalid git reference.");
  return ref;
}

export async function buildProjectImpact(input: { projectId: string; baseRef?: string | null; headRef?: string | null }): Promise<ProjectImpactReport> {
  const project = getConnectedProject(input.projectId); if (!project) throw new Error("Connected project not found.");
  const baseRef=safeRef(input.baseRef); const headRef=safeRef(input.headRef);
  let changedFiles:string[]=[];
  if(baseRef){
    const range=headRef?`${baseRef}...${headRef}`:baseRef;
    const output=await runProjectGit(project.canonicalRoot,["diff","--name-only","--diff-filter=ACMR",range,"--"]);
    if(output===null) throw new Error("Git diff failed for the selected references.");
    changedFiles=output.split(/\r?\n/).map((item)=>item.trim().replace(/\\/g,"/")).filter(Boolean);
  } else {
    const output=await runProjectGit(project.canonicalRoot,["status","--porcelain=v1","--untracked-files=all"]);
    if(output===null) throw new Error("Git status is unavailable for this project.");
    changedFiles=output.split(/\r?\n/).map((line)=>line.slice(3).split(" -> ").pop()?.trim().replace(/\\/g,"/")||"").filter(Boolean);
  }
  changedFiles=[...new Set(changedFiles)];
  const files=listProjectFiles(input.projectId); const byId=new Map(files.map((file)=>[file.id,file])); const byPath=new Map(files.map((file)=>[file.relativePath,file]));
  const reverse=new Map<string,string[]>(); for(const edge of listProjectEdges(input.projectId)){ const current=reverse.get(edge.targetId)||[]; current.push(edge.sourceId); reverse.set(edge.targetId,current); }
  const distance=new Map<string,number>(); const queue:Array<{id:string;distance:number}>=[];
  for(const relativePath of changedFiles){const file=byPath.get(relativePath);if(file){distance.set(file.id,0);queue.push({id:file.id,distance:0});}}
  while(queue.length){const current=queue.shift()!;if(current.distance>=3)continue;for(const dependent of reverse.get(current.id)||[]){const next=current.distance+1;if((distance.get(dependent)??99)<=next)continue;distance.set(dependent,next);queue.push({id:dependent,distance:next});}}
  const affectedNodes=[...distance.entries()].map(([id,d])=>({path:byId.get(id)?.relativePath||id,distance:d,reason:d===0?"directly changed":`${d}-hop import dependent`})).sort((a,b)=>a.distance-b.distance||a.path.localeCompare(b.path));
  return createImpactReport({projectId:input.projectId,baseRef,headRef,changedFiles,affectedNodes,summary:{direct:affectedNodes.filter((item)=>item.distance===0).length,oneHop:affectedNodes.filter((item)=>item.distance===1).length,transitive:affectedNodes.filter((item)=>item.distance>1).length,semanticRisk:"Not inferred automatically; request a cited review in Ask."}});
}

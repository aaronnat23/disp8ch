import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { deleteConnectedProject, getConnectedProject, listImpactReports, listProjectEdges, listProjectFiles, listProjectSymbols } from "@/lib/projects/store";
import { scanProject } from "@/lib/projects/scanner";

const Schema=z.discriminatedUnion("action",[z.object({action:z.literal("scan")}),z.object({action:z.literal("disconnect"),confirmed:z.literal(true)})]);
export async function GET(request:NextRequest,{params}:{params:{id:string}}){const denied=await requireOperatorAccess(request);if(denied)return denied;const project=getConnectedProject(params.id);if(!project)return NextResponse.json({success:false,error:"Connected project not found."},{status:404});return NextResponse.json({success:true,data:{project,files:listProjectFiles(params.id),symbols:listProjectSymbols(params.id),edges:listProjectEdges(params.id),impacts:listImpactReports(params.id)}});}
export async function POST(request:NextRequest,{params}:{params:{id:string}}){const denied=await requireOperatorAccess(request);if(denied)return denied;try{const input=Schema.parse(await request.json());if(input.action==="disconnect")return NextResponse.json({success:true,data:{deleted:deleteConnectedProject(params.id)}});return NextResponse.json({success:true,data:await scanProject(params.id)});}catch(error){return NextResponse.json({success:false,error:error instanceof z.ZodError?error.flatten():String(error)},{status:400});}}

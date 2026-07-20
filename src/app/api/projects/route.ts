import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { connectProject, scanProject } from "@/lib/projects/scanner";
import { listConnectedProjects } from "@/lib/projects/store";

const Schema=z.object({root:z.string().min(1).max(2000),name:z.string().max(200).optional(),confirmed:z.literal(true),workTrailId:z.string().max(200).nullable().optional()});
export async function GET(request:NextRequest){const denied=await requireOperatorAccess(request);if(denied)return denied;return NextResponse.json({success:true,data:listConnectedProjects()});}
export async function POST(request:NextRequest){const denied=await requireOperatorAccess(request);if(denied)return denied;try{const input=Schema.parse(await request.json());const project=await connectProject(input);const scan=await scanProject(project.id);return NextResponse.json({success:true,data:scan},{status:201});}catch(error){return NextResponse.json({success:false,error:error instanceof z.ZodError?error.flatten():String(error)},{status:400});}}

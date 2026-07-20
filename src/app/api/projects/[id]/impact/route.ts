import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { buildProjectImpact } from "@/lib/projects/impact";

const Schema=z.object({baseRef:z.string().max(200).nullable().optional(),headRef:z.string().max(200).nullable().optional()});
export async function POST(request:NextRequest,{params}:{params:{id:string}}){const denied=await requireOperatorAccess(request);if(denied)return denied;try{return NextResponse.json({success:true,data:await buildProjectImpact({projectId:params.id,...Schema.parse(await request.json())})});}catch(error){return NextResponse.json({success:false,error:error instanceof z.ZodError?error.flatten():String(error)},{status:400});}}

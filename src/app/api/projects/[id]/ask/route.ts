import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { askConnectedProject } from "@/lib/projects/intelligence";

const Schema=z.object({question:z.string().min(1).max(4000)});
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){const denied=await requireOperatorAccess(request);if(denied)return denied;try{const {id}=await params;const {question}=Schema.parse(await request.json());return NextResponse.json({success:true,data:await askConnectedProject({projectId:id,question})});}catch(error){return NextResponse.json({success:false,error:error instanceof z.ZodError?error.flatten():String(error)},{status:400});}}

import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { readConnectedProjectFile } from "@/lib/projects/scanner";

export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){const denied=await requireOperatorAccess(request);if(denied)return denied;try{const {id}=await params;const relativePath=new URL(request.url).searchParams.get("path")||"";return NextResponse.json({success:true,data:await readConnectedProjectFile(id,relativePath)});}catch(error){return NextResponse.json({success:false,error:String(error)},{status:400});}}

import {NextRequest,NextResponse} from "next/server";
import {isHeadquartersAdmin} from "@/lib/account-management";
import {backupMode,publicBackupError,requestBackupRun} from "@/lib/attendance-backup-api";
import {verifyUserToken} from "@/lib/firebase-rest";
export const runtime="nodejs";
export async function POST(request:NextRequest){const auth=await verifyUserToken(request.headers.get("authorization"));if(!auth||!isHeadquartersAdmin(auth.profile))return NextResponse.json({error:"本部管理者のみ利用できます",code:"FORBIDDEN"},{status:403});try{return NextResponse.json(requestBackupRun(backupMode()),{status:202});}catch(error){const result=publicBackupError(error);return NextResponse.json(result.body,{status:result.status});}}

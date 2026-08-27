import {NextRequest,NextResponse} from "next/server";
import {isHeadquartersAdmin} from "@/lib/account-management";
import {backupMode,publicBackupError,requestRestore} from "@/lib/attendance-backup-api";
import {verifyUserToken} from "@/lib/firebase-rest";
import type {BackupStatus,ClockLogSnapshot,RestorePreviewResult} from "@/lib/attendance-backups";
export const runtime="nodejs";
type Body={preview:RestorePreviewResult;current:ClockLogSnapshot[];selectedDocumentIds:string[];preRestoreBackupStatus:BackupStatus};
export async function POST(request:NextRequest){const auth=await verifyUserToken(request.headers.get("authorization"));if(!auth||!isHeadquartersAdmin(auth.profile))return NextResponse.json({error:"本部管理者のみ利用できます",code:"FORBIDDEN"},{status:403});try{const body=await request.json() as Body;return NextResponse.json(requestRestore(backupMode(),body));}catch(error){const result=publicBackupError(error);return NextResponse.json(result.body,{status:result.status});}}

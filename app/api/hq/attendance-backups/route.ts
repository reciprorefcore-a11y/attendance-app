import {NextRequest,NextResponse} from "next/server";
import {isHeadquartersAdmin} from "@/lib/account-management";
import {backupMode,getBackupOverview} from "@/lib/attendance-backup-api";
import {verifyUserToken} from "@/lib/firebase-rest";
export const runtime="nodejs";
export async function GET(request:NextRequest){const auth=await verifyUserToken(request.headers.get("authorization"));if(!auth||!isHeadquartersAdmin(auth.profile))return NextResponse.json({error:"本部管理者のみ利用できます",code:"FORBIDDEN"},{status:403});return NextResponse.json(getBackupOverview(backupMode()));}

"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { db } from "@/lib/firebase";
import { adminStyles as styles } from "@/lib/adminStyles";
import { useAuthProfile } from "@/lib/auth";
import { isFullTimeEmployee } from "@/lib/employee-classification";
import { calculateTotalFixedSalary, isActiveFullTimeMaster, isInactiveFullTimeMaster, migrateLegacyFixedSalary, type FullTimeMasterInput } from "@/lib/fulltime-master";
import { calculateAutomaticStatutoryDeductions } from "@/lib/payroll-statutory";
import {
  Employee,
  EmploymentType,
  Store,
  employmentTypeLabels,
  statusLabels,
} from "@/lib/attendance";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";

type EmployeeRow = Employee & { id: string; fixedBaseSalary?: number | null; skillAllowance?:number|null; fixedOvertimeSupplement?:number|null; fixedOvertimeHours?:number|null; otherFixedAllowance?:number|null; otherFixedAllowanceName?:string|null; monthlyTransportation?: number | null; dailyTransportation?: number | null; residentTax?: number | null; healthInsurance?: number | null; childSupportContribution?: number | null; careInsurance?: number | null; employeePension?: number | null; employmentInsurance?: number | null; incomeTax?: number | null; dependentCount?: number; taxTableType?: "kou"|"otsu"; socialInsuranceEnrolled?: boolean; standardMonthlyRemuneration?: number; careInsuranceApplicable?: boolean; employmentInsuranceEnrolled?: boolean; isActive?: boolean; retirementDate?: string };
type StoreRow = Store & { id: string };
type WageInput = {
  hourlyWage: string;
  lateNightHourlyWage: string;
  dailyTransportation: string;
};

const emptyForm = {
  employeeCode: "",
  name: "",
  nameKana: "",
  storeId: "",
  employmentType: "part_time" as EmploymentType,
  hourlyWage: "", transportationCost: "", transportationType: "none" as "daily" | "monthly" | "none", payrollEnabled: true,
  paymentMethod: "bank" as "bank" | "cash",
  fixedBaseSalary: "", directorCompensation: "", positionAllowance: "", businessAllowance: "", holidayAllowance: "", fixedOvertimeAllowance: "",
  healthInsurance: "", childSupportContribution: "", careInsurance: "", employeePension: "", employmentInsurance: "", incomeTax: "", residentTax: "",
};

const yen = (v: number) => `${Math.trunc(v || 0).toLocaleString()}円`;
const currentMonth = () => new Date(Date.now()+9*3600000).toISOString().slice(0,7);
const blankFullTimeMaster = (): FullTimeMasterInput => ({name:"",nameKana:"",employeeCode:"",storeId:"",storeName:"",fixedBaseSalary:0,directorCompensation:0,positionAllowance:0,skillAllowance:0,fixedOvertimeAllowance:0,fixedOvertimeSupplement:0,fixedOvertimeHours:null,otherFixedAllowance:0,otherFixedAllowanceName:"",transportationType:"none",transportationAmount:0,residentTax:0,dependentCount:0,taxTableType:"kou",socialInsuranceEnrolled:false,standardMonthlyRemuneration:0,careInsuranceApplicable:false,employmentInsuranceEnrolled:false,effectiveMonth:currentMonth(),reason:""});

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

export default function HqEmployeesPage() {
  const { user } = useAuthProfile();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [wages, setWages] = useState<Record<string, WageInput>>({});
  const [message, setMessage] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [employeeTab, setEmployeeTab] = useState<"hourly" | "fixed">("fixed");
  const [fullTimeFilter,setFullTimeFilter]=useState<"active"|"inactive">("active");
  const [fullTimeEditor,setFullTimeEditor]=useState<{mode:"create"|"edit";employeeId?:string;before?:FullTimeMasterInput;value:FullTimeMasterInput}|null>(null);
  const [fullTimeDetail,setFullTimeDetail]=useState<EmployeeRow|null>(null);
  const [fullTimeConfirm,setFullTimeConfirm]=useState(false);

  const load = async () => {
    const [employeeSnapshot, storeSnapshot, payrollSnapshot] = await Promise.all([
      getDocs(query(collection(db, "employees"), orderBy("employeeCode"))),
      getDocs(query(collection(db, "stores"), orderBy("storeName"))),
      getDocs(collection(db, "payrollSettings")),
    ]);
    const settings = new Map(payrollSnapshot.docs.map((item) => [item.id, item.data()]));
    const rows = employeeSnapshot.docs.map((employeeDoc) => ({
      id: employeeDoc.id,
      ...(employeeDoc.data() as Employee),
      ...(settings.get(employeeDoc.id) ?? {}),
    }));

    setEmployees(rows);
    setStores(
      storeSnapshot.docs.map((storeDoc) => ({
        id: storeDoc.id,
        ...(storeDoc.data() as Store),
      })),
    );
    setWages((current) => {
      const next = { ...current };
      for (const employee of rows.filter((row) => row.status === "pending")) {
        next[employee.id] ??= {
          hourlyWage: "",
          lateNightHourlyWage: "",
          dailyTransportation: "",
        };
      }
      return next;
    });
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  const pendingEmployees = useMemo(
    () => employees.filter((employee) => employee.status === "pending"),
    [employees],
  );

  const selectedStore = stores.find((store) => store.id === form.storeId);
  const fullTimeRows=useMemo(()=>employees.filter((employee)=>fullTimeFilter==="active"?isActiveFullTimeMaster(employee):isInactiveFullTimeMaster(employee)),[employees,fullTimeFilter]);

  const createEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const employeeCode = form.employeeCode.trim();
    if (!employeeCode || !form.name.trim() || !form.nameKana.trim() || !selectedStore) {
      setMessage("社員コード、氏名、ひらがな、所属店舗を入力してください。");
      return;
    }

    setIsSubmitting(true);
    setMessage("");

    try {
      if (!user) throw new Error("認証情報を取得できません。");
      const token = await user.getIdToken(true);
      const response = await fetch("/api/employees", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({
          employeeCode,
          name: form.name.trim(),
          nameKana: form.nameKana.trim(),
          ...(selectedStore ? { storeId: selectedStore.id, storeName: selectedStore.storeName } : {}),
          employeeType: "partTime",
          employmentType: "part_time",
          payrollType: "hourly",
          clockEnabled: true,
          baseWage: Number(form.hourlyWage) || 0,
          hourlyWage: Number(form.hourlyWage) || 0,
          transportationCost: Number(form.transportationCost) || 0,
          transportationType: form.transportationType,
          payrollEnabled: form.payrollEnabled,
          status: "active",
          createdAt: new Date(),
      }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "従業員の登録に失敗しました。");

      setMessage("従業員を登録しました。");
      setForm(emptyForm);
      await load();
    } finally {
      setIsSubmitting(false);
    }
  };

  const editorValue=(employee:EmployeeRow):FullTimeMasterInput=>{const salary=migrateLegacyFixedSalary(employee);return {name:employee.name,nameKana:employee.nameKana??"",employeeCode:employee.employeeCode,storeId:employee.storeId??"",storeName:employee.storeName??"",...salary,transportationType:employee.transportationType??"none",transportationAmount:Number(employee.transportationType==="daily"?employee.dailyTransportation:employee.monthlyTransportation)||0,residentTax:Number(employee.residentTax)||0,dependentCount:Number(employee.dependentCount)||0,taxTableType:employee.taxTableType??"kou",socialInsuranceEnrolled:employee.socialInsuranceEnrolled===true,standardMonthlyRemuneration:Number(employee.standardMonthlyRemuneration)||0,careInsuranceApplicable:employee.careInsuranceApplicable===true,employmentInsuranceEnrolled:employee.employmentInsuranceEnrolled===true,effectiveMonth:currentMonth(),reason:""};};
  const saveFullTimeMaster=async()=>{if(!fullTimeEditor||!user)return;setIsSubmitting(true);try{const token=await user.getIdToken(true),url=fullTimeEditor.mode==="create"?"/api/fulltime-employees":`/api/fulltime-employees/${fullTimeEditor.employeeId}`,response=await fetch(url,{method:fullTimeEditor.mode==="create"?"POST":"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(fullTimeEditor.value)}),body=await response.json() as {error?:string};if(!response.ok)throw new Error(body.error??"保存に失敗しました");setMessage(fullTimeEditor.mode==="create"?"正社員を登録しました。":"正社員マスターを更新しました。");setFullTimeEditor(null);setFullTimeConfirm(false);await load();}catch(error){setMessage(error instanceof Error?error.message:"保存に失敗しました");}finally{setIsSubmitting(false);}};
  const changeFullTimeStatus=async(employee:EmployeeRow,active:boolean)=>{if(!user)return;const retirementDate=active?undefined:window.prompt(`${employee.name}さんの退職日（YYYY-MM-DD）`,todayString());if(!active&&!retirementDate)return;const reason=active?"再有効化":window.prompt(`${employee.name}さんを退職・無効化する理由`);if(!reason)return;if(!window.confirm(`${employee.name}さんを${active?"再有効化":"退職・無効化"}します。物理削除は行いません。`))return;const token=await user.getIdToken(true),response=await fetch(`/api/fulltime-employees/${employee.id}/status`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({active,retirementDate,reason})}),body=await response.json() as {error?:string};if(!response.ok){setMessage(body.error??"状態変更に失敗しました");return;}setMessage(`${employee.name}さんを${active?"再有効化":"退職・無効化"}しました。`);await load();};

  const approve = async (employee: EmployeeRow) => {
    const wage = wages[employee.id];
    const hourlyWage = Number(wage?.hourlyWage);
    const lateNightHourlyWage = Number(wage?.lateNightHourlyWage);
    const dailyTransportation = Number(wage?.dailyTransportation);

    if (!hourlyWage || !lateNightHourlyWage || Number.isNaN(dailyTransportation)) {
      setMessage("時給、深夜時給、日交通費を入力してください。");
      return;
    }

    const employeeRef = doc(db, "employees", employee.id);
    await addDoc(collection(employeeRef, "wageHistory"), {
      hourlyWage,
      lateNightHourlyWage,
      dailyTransportation,
      effectiveFrom: todayString(),
      effectiveTo: null,
      approvedAt: serverTimestamp(),
      approvedBy: "HQ",
    });
    await updateDoc(employeeRef, {
      status: "active",
      approvedAt: serverTimestamp(),
      approvedBy: "HQ",
      updatedAt: serverTimestamp(),
    });
    setMessage("承認しました。");
    await load();
  };

  const reject = async (employee: EmployeeRow) => {
    await updateDoc(doc(db, "employees", employee.id), {
      status: "rejected",
      updatedAt: serverTimestamp(),
    });
    setMessage("差戻しました。");
    await load();
  };

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>従業員管理</h1>
        </header>

        <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
          <button type="button" onClick={() => setEmployeeTab("hourly")} style={employeeTab === "hourly" ? styles.button : styles.secondaryButton}>① アルバイト</button>
          <button type="button" onClick={() => setEmployeeTab("fixed")} style={employeeTab === "fixed" ? styles.button : styles.secondaryButton}>② 正社員</button>
        </div>

        {message && <p style={styles.success}>{message}</p>}

        {employeeTab === "fixed" && (
          <section style={styles.panel}>
            <h2 style={{...styles.title,fontSize:22}}>正社員マスター</h2>
            <button type="button" onClick={()=>setFullTimeEditor({mode:"create",value:blankFullTimeMaster()})} style={styles.button}>＋ 正社員を登録</button>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",margin:"16px 0"}}><button type="button" onClick={()=>setFullTimeFilter("active")} style={fullTimeFilter==="active"?styles.button:styles.secondaryButton}>在籍</button><button type="button" onClick={()=>setFullTimeFilter("inactive")} style={fullTimeFilter==="inactive"?styles.button:styles.secondaryButton}>退職・無効</button></div>
            <p style={{fontWeight:800}}>正社員 {fullTimeRows.length}人</p>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:12}}>{fullTimeRows.map(employee=>{const salary=migrateLegacyFixedSalary(employee);const total=calculateTotalFixedSalary(salary);const automatic=calculateAutomaticStatutoryDeductions({taxableEarnings:total,socialInsuranceEnrolled:employee.socialInsuranceEnrolled,standardMonthlyRemuneration:employee.standardMonthlyRemuneration,careInsuranceApplicable:employee.careInsuranceApplicable,employmentInsuranceEnrolled:employee.employmentInsuranceEnrolled});return <article key={employee.id} style={{border:"1px solid #CBD5E1",borderRadius:12,padding:16,minWidth:0}}><h3 style={{margin:"0 0 4px"}}>{employee.name}</h3><p style={{margin:"0 0 12px",color:"#64748B"}}>{employee.employeeCode}・{employee.status==="inactive"?"退職・無効":"在籍"}</p><dl style={{display:"grid",gridTemplateColumns:"145px 1fr",gap:6,fontSize:13}}><dt>所属店舗</dt><dd>{employee.storeName||"所属なし"}</dd><dt>雇用区分</dt><dd>正社員</dd><dt>基本給</dt><dd>{yen(salary.fixedBaseSalary)}</dd><dt>役職手当</dt><dd>{yen(salary.positionAllowance)}</dd><dt>職能手当</dt><dd>{yen(salary.skillAllowance)}</dd><dt>業務手当（固定残業）</dt><dd>{yen(salary.fixedOvertimeAllowance)}</dd><dt>固定残業手当（別枠）</dt><dd>{yen(salary.fixedOvertimeSupplement)}</dd><dt>固定残業時間</dt><dd>{salary.fixedOvertimeHours==null?"未設定":`${salary.fixedOvertimeHours}時間`}</dd><dt>その他固定手当</dt><dd>{yen(salary.otherFixedAllowance)}{salary.otherFixedAllowanceName?`（${salary.otherFixedAllowanceName}）`:""}</dd><dt style={{borderTop:"1px solid #94A3B8",paddingTop:6}}>固定給与合計</dt><dd style={{borderTop:"1px solid #94A3B8",paddingTop:6,fontWeight:800}}>{yen(total)}</dd><dt>交通費</dt><dd>{employee.transportationType??"none"}・{yen(Number(employee.transportationType==="daily"?employee.dailyTransportation:employee.monthlyTransportation)||0)}</dd><dt>住民税</dt><dd>{yen(employee.residentTax??0)}</dd><dt>標準報酬月額</dt><dd>{employee.standardMonthlyRemuneration?yen(employee.standardMonthlyRemuneration):"未設定"}</dd><dt>社会保険</dt><dd>{automatic.socialInsuranceTotal==null?"自動計算不可（設定不足）":`自動 ${yen(automatic.socialInsuranceTotal)}`}</dd><dt>所得税</dt><dd>{employee.incomeTax==null?"給与試算で自動計算":"現行固定値あり"}</dd></dl><div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:14}}><button type="button" onClick={()=>setFullTimeDetail(employee)} style={styles.secondaryButton}>詳細</button><button type="button" onClick={()=>{const value=editorValue(employee);setFullTimeEditor({mode:"edit",employeeId:employee.id,before:value,value});}} style={styles.secondaryButton}>編集</button>{isActiveFullTimeMaster(employee)?<button type="button" onClick={()=>changeFullTimeStatus(employee,false)} style={styles.dangerButton}>退職・無効化</button>:<button type="button" onClick={()=>changeFullTimeStatus(employee,true)} style={styles.button}>再有効化</button>}</div></article>;})}</div>
            {fullTimeRows.length===0&&<p style={{color:"#64748B"}}>対象の正社員はいません</p>}
          </section>
        )}

        {employeeTab === "hourly" && <>
        <form style={styles.panel} onSubmit={createEmployee}>
          <h2 style={{ ...styles.title, fontSize: 18 }}>アルバイトを新規登録</h2>
          <div style={{ ...styles.grid, marginTop: 14 }}>
            <label style={styles.label}>
              社員コード
              <input required value={form.employeeCode} onChange={(event) => setForm({ ...form, employeeCode: event.target.value })} style={styles.input} />
            </label>
            <label style={styles.label}>
              氏名
              <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} style={styles.input} />
            </label>
            <label style={styles.label}>
              ひらがな
              <input required value={form.nameKana} onChange={(event) => setForm({ ...form, nameKana: event.target.value })} style={styles.input} />
            </label>
            <label style={styles.label}>
              所属店舗
              <select required value={form.storeId} onChange={(event) => setForm({ ...form, storeId: event.target.value })} style={styles.input}>
                <option value="">選択してください</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>{store.storeName}</option>
                ))}
              </select>
            </label>
            <>
              <label style={styles.label}>時給<input type="number" value={form.hourlyWage} onChange={(e) => setForm({ ...form, hourlyWage: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>交通費<input type="number" value={form.transportationCost} onChange={(e) => setForm({ ...form, transportationCost: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>交通費種別<select value={form.transportationType} onChange={(e) => setForm({ ...form, transportationType: e.target.value as typeof form.transportationType })} style={styles.input}><option value="none">なし</option><option value="daily">日額</option><option value="monthly">月額</option></select></label>
            </>
            <label style={styles.label}>給与対象<select value={form.payrollEnabled ? "yes" : "no"} onChange={(e) => setForm({ ...form, payrollEnabled: e.target.value === "yes" })} style={styles.input}><option value="yes">対象</option><option value="no">対象外</option></select></label>
            <label style={styles.label}>打刻対象<select value="yes" disabled style={styles.input}><option value="yes">対象</option></select></label>
          </div>
          <button type="submit" disabled={isSubmitting} style={{ ...styles.button, marginTop: 14 }}>
            {isSubmitting ? "登録中" : "登録"}
          </button>
        </form>

        <section style={styles.panel}>
          <h2 style={{ ...styles.title, fontSize: 18, marginBottom: 14 }}>承認待ち</h2>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>名前</th>
                  <th style={styles.th}>ひらがな</th>
                  <th style={styles.th}>社員コード</th>
                  <th style={styles.th}>所属店舗</th>
                  <th style={styles.th}>雇用区分</th>
                  <th style={styles.th}>時給</th>
                  <th style={styles.th}>深夜時給</th>
                  <th style={styles.th}>日交通費</th>
                  <th style={styles.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {pendingEmployees.map((employee) => (
                  <tr key={employee.id}>
                    <td style={styles.td}>{employee.name}</td>
                    <td style={styles.td}>{employee.nameKana}</td>
                    <td style={styles.td}>{employee.employeeCode}</td>
                    <td style={styles.td}>{employee.employeeType === "fullTime" || employee.payrollType === "fixed" ? "所属なし" : employee.storeName}</td>
                    <td style={styles.td}>{employmentTypeLabels[employee.employmentType]}</td>
                    <td style={styles.td}>
                      <input type="number" value={wages[employee.id]?.hourlyWage ?? ""} onChange={(event) => setWages({ ...wages, [employee.id]: { ...wages[employee.id], hourlyWage: event.target.value } })} style={{ ...styles.input, width: 100 }} />
                    </td>
                    <td style={styles.td}>
                      <input type="number" value={wages[employee.id]?.lateNightHourlyWage ?? ""} onChange={(event) => setWages({ ...wages, [employee.id]: { ...wages[employee.id], lateNightHourlyWage: event.target.value } })} style={{ ...styles.input, width: 100 }} />
                    </td>
                    <td style={styles.td}>
                      <input type="number" value={wages[employee.id]?.dailyTransportation ?? ""} onChange={(event) => setWages({ ...wages, [employee.id]: { ...wages[employee.id], dailyTransportation: event.target.value } })} style={{ ...styles.input, width: 100 }} />
                    </td>
                    <td style={styles.td}>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" onClick={() => approve(employee)} style={styles.secondaryButton}>承認</button>
                        <button type="button" onClick={() => reject(employee)} style={styles.dangerButton}>差戻し</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        </>}

        {fullTimeDetail&&(()=>{const salary=migrateLegacyFixedSalary(fullTimeDetail);return <div style={styles.modalOverlay} onClick={()=>setFullTimeDetail(null)}><div style={{...styles.modal,maxWidth:620}} onClick={e=>e.stopPropagation()}><h2>{fullTimeDetail.name}さんの詳細</h2><pre style={{whiteSpace:"pre-wrap",fontFamily:"inherit",lineHeight:1.8}}>社員コード：{fullTimeDetail.employeeCode}{"\n"}在籍状態：{isActiveFullTimeMaster(fullTimeDetail)?"在籍":"退職・無効"}{"\n"}所属店舗：{fullTimeDetail.storeName||"所属なし"}{"\n"}基本給：{yen(salary.fixedBaseSalary)}{"\n"}役員報酬：{yen(salary.directorCompensation)}{"\n"}役職手当：{yen(salary.positionAllowance)}{"\n"}職能手当：{yen(salary.skillAllowance)}{"\n"}業務手当（固定残業）：{yen(salary.fixedOvertimeAllowance)}{"\n"}固定残業手当（別枠）：{yen(salary.fixedOvertimeSupplement)}{"\n"}固定残業時間：{salary.fixedOvertimeHours==null?"未設定":`${salary.fixedOvertimeHours}時間`}{"\n"}その他固定手当：{yen(salary.otherFixedAllowance)}{salary.otherFixedAllowanceName?`（${salary.otherFixedAllowanceName}）`:""}{"\n"}固定給与合計：{yen(calculateTotalFixedSalary(salary))}{"\n"}交通費：{yen(Number(fullTimeDetail.transportationType==="daily"?fullTimeDetail.dailyTransportation:fullTimeDetail.monthlyTransportation)||0)}{"\n"}住民税：{yen(fullTimeDetail.residentTax??0)}{"\n"}標準報酬月額：{fullTimeDetail.standardMonthlyRemuneration?yen(fullTimeDetail.standardMonthlyRemuneration):"未設定"}{"\n"}扶養人数：{fullTimeDetail.dependentCount??0}人{"\n"}税区分：{fullTimeDetail.taxTableType==="otsu"?"乙欄":"甲欄"}</pre><button type="button" onClick={()=>setFullTimeDetail(null)} style={styles.secondaryButton}>閉じる</button></div></div>;})()}
        {fullTimeEditor&&<div style={styles.modalOverlay} onClick={()=>{if(!isSubmitting){setFullTimeEditor(null);setFullTimeConfirm(false);}}}><div style={{...styles.modal,maxWidth:800,maxHeight:"90vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}><h2>{fullTimeEditor.mode==="create"?"正社員を新規登録":"正社員を編集"}</h2>{fullTimeConfirm?<><p>以下の変更を保存します。既存社員の編集では新しいemployeeIdを作成しません。</p><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}><pre style={{whiteSpace:"pre-wrap"}}>変更前{"\n"}{fullTimeEditor.before?JSON.stringify(fullTimeEditor.before,null,2):"新規登録"}</pre><pre style={{whiteSpace:"pre-wrap"}}>変更後{"\n"}{JSON.stringify({...fullTimeEditor.value,totalFixedSalary:calculateTotalFixedSalary(fullTimeEditor.value)},null,2)}</pre></div></>:<div style={{...styles.grid,marginTop:12}}>{([["name","氏名","text"],["employeeCode","社員コード","text"],["nameKana","ひらがな","text"],["fixedBaseSalary","基本給","number"],["directorCompensation","役員報酬","number"],["positionAllowance","役職手当","number"],["skillAllowance","職能手当","number"],["fixedOvertimeAllowance","業務手当（固定残業）","number"],["fixedOvertimeSupplement","固定残業手当（別枠）","number"],["otherFixedAllowance","その他固定手当","number"],["otherFixedAllowanceName","その他固定手当の名称","text"],["transportationAmount","交通費金額","number"],["residentTax","住民税","number"],["dependentCount","扶養人数","number"],["standardMonthlyRemuneration","標準報酬月額","number"],["effectiveMonth","適用開始月","month"],["reason","変更理由","text"]] as const).map(([key,label,type])=><label key={key} style={styles.label}>{label}<input type={type} value={String(fullTimeEditor.value[key])} onChange={e=>setFullTimeEditor({...fullTimeEditor,value:{...fullTimeEditor.value,[key]:type==="number"?Number(e.target.value):e.target.value}})} style={styles.input}/></label>)}<label style={styles.label}>固定残業時間（時間）<input type="number" min="0" step="0.25" placeholder="未設定" value={fullTimeEditor.value.fixedOvertimeHours??""} onChange={e=>setFullTimeEditor({...fullTimeEditor,value:{...fullTimeEditor.value,fixedOvertimeHours:e.target.value===""?null:Number(e.target.value)}})} style={styles.input}/></label><div style={{...styles.label,fontWeight:800,borderTop:"1px solid #94A3B8",paddingTop:10}}>固定給与合計<span>{yen(calculateTotalFixedSalary(fullTimeEditor.value))}</span></div><label style={styles.label}>所属店舗<select value={fullTimeEditor.value.storeId} onChange={e=>{const store=stores.find(s=>s.id===e.target.value);setFullTimeEditor({...fullTimeEditor,value:{...fullTimeEditor.value,storeId:e.target.value,storeName:store?.storeName??""}})}} style={styles.input}><option value="">所属なし</option>{stores.map(s=><option key={s.id} value={s.id}>{s.storeName}</option>)}</select></label><label style={styles.label}>交通費区分<select value={fullTimeEditor.value.transportationType} onChange={e=>setFullTimeEditor({...fullTimeEditor,value:{...fullTimeEditor.value,transportationType:e.target.value as FullTimeMasterInput["transportationType"]}})} style={styles.input}><option value="none">なし</option><option value="daily">日額</option><option value="monthly">月額</option></select></label><label style={styles.label}>甲欄・乙欄<select value={fullTimeEditor.value.taxTableType} onChange={e=>setFullTimeEditor({...fullTimeEditor,value:{...fullTimeEditor.value,taxTableType:e.target.value as "kou"|"otsu"}})} style={styles.input}><option value="kou">甲欄</option><option value="otsu">乙欄</option></select></label>{([['socialInsuranceEnrolled','社会保険加入'],['careInsuranceApplicable','介護保険対象'],['employmentInsuranceEnrolled','雇用保険加入']] as const).map(([key,label])=><label key={key} style={styles.label}>{label}<select value={fullTimeEditor.value[key]?"yes":"no"} onChange={e=>setFullTimeEditor({...fullTimeEditor,value:{...fullTimeEditor.value,[key]:e.target.value==="yes"}})} style={styles.input}><option value="yes">はい</option><option value="no">いいえ</option></select></label>)}</div>}<div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:16}}>{fullTimeConfirm?<button type="button" disabled={isSubmitting} onClick={saveFullTimeMaster} style={styles.button}>{isSubmitting?"保存中":"保存する"}</button>:<button type="button" onClick={()=>setFullTimeConfirm(true)} style={styles.button}>変更前後を確認</button>}{fullTimeConfirm&&<button type="button" onClick={()=>setFullTimeConfirm(false)} style={styles.secondaryButton}>入力へ戻る</button>}<button type="button" onClick={()=>setFullTimeEditor(null)} style={styles.secondaryButton}>キャンセル</button></div></div></div>}

        {employeeTab === "hourly" && <section style={styles.panel}>
          <h2 style={{ ...styles.title, fontSize: 18, marginBottom: 14 }}>登録済み従業員一覧</h2>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>社員コード</th>
                  <th style={styles.th}>氏名</th>
                  <th style={styles.th}>ひらがな</th>
                  <th style={styles.th}>所属店舗</th>
                  <th style={styles.th}>雇用区分</th>
                  <th style={styles.th}>状態</th>
                </tr>
              </thead>
              <tbody>
                {employees
                  .filter((employee) => employee.isDeleted !== true && !isFullTimeEmployee(employee))
                  .map((employee) => (
                    <tr key={employee.id}>
                      <td style={styles.td}>{employee.employeeCode}</td>
                      <td style={styles.td}>{employee.name}</td>
                      <td style={styles.td}>{employee.nameKana}</td>
                      <td style={styles.td}>{isFullTimeEmployee(employee) ? "所属なし" : employee.storeName}</td>
                      <td style={styles.td}>{employmentTypeLabels[employee.employmentType]}</td>
                      <td style={styles.td}>{statusLabels[employee.status]}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>}
      </div>
    </main>
  );
}

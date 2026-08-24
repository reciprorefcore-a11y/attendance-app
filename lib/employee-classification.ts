export type EmployeeClassificationFields = {
  isDeleted?: boolean | null;
  employeeType?: string | null;
  employmentType?: string | null;
  payrollType?: string | null;
};

export function isFullTimeEmployee(employee: EmployeeClassificationFields): boolean {
  return employee.employeeType === "fullTime"
    || employee.employmentType === "full_time"
    || employee.payrollType === "fixed";
}

export function isAdminPartTimeEmployee(employee: EmployeeClassificationFields): boolean {
  return employee.isDeleted !== true && !isFullTimeEmployee(employee);
}

export function isActiveFullTimeEmployee(employee: EmployeeClassificationFields): boolean {
  return employee.isDeleted !== true && isFullTimeEmployee(employee);
}

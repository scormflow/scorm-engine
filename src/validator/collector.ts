import type { IssueCategory, IssueSeverity, ValidationIssue } from './types.js';

/**
 * Accumulates issues, capping each code at `maxPerCode` so a package with
 * thousands of broken references still yields a readable report. The overflow
 * is folded into one trailing issue per code.
 */
export class IssueCollector {
  private readonly issues: ValidationIssue[] = [];
  private readonly counts = new Map<string, number>();
  private readonly firstOf = new Map<string, ValidationIssue>();

  constructor(private readonly maxPerCode: number) {}

  add(
    severity: IssueSeverity,
    category: IssueCategory,
    code: string,
    message: string,
    path: string | null = null,
  ): void {
    const count = (this.counts.get(code) ?? 0) + 1;
    this.counts.set(code, count);
    if (count > this.maxPerCode) return;
    const issue = { code, severity, category, message, path };
    if (count === 1) this.firstOf.set(code, issue);
    this.issues.push(issue);
  }

  error(category: IssueCategory, code: string, message: string, path?: string | null): void {
    this.add('error', category, code, message, path);
  }

  warn(category: IssueCategory, code: string, message: string, path?: string | null): void {
    this.add('warning', category, code, message, path);
  }

  info(category: IssueCategory, code: string, message: string, path?: string | null): void {
    this.add('info', category, code, message, path);
  }

  hasErrors(): boolean {
    return this.issues.some((i) => i.severity === 'error');
  }

  result(): ValidationIssue[] {
    const out = [...this.issues];
    for (const [code, count] of this.counts) {
      if (count <= this.maxPerCode) continue;
      const first = this.firstOf.get(code)!;
      out.push({
        code,
        severity: first.severity,
        category: first.category,
        message: `…and ${count - this.maxPerCode} more '${code}' issue(s)`,
        path: null,
      });
    }
    return out;
  }
}

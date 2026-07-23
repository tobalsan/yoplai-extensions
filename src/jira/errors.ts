export class JiraError extends Error {
  constructor(message: string, public status?: number, public requestId?: string, public details?: unknown, public endpoint?: string, public responseBody?: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class JiraAuthError extends JiraError {}
export class JiraValidationError extends JiraError {}

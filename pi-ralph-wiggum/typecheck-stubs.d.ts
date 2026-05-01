declare module "node:fs" {
  export const existsSync: any;
  export const mkdirSync: any;
  export const readdirSync: any;
  export const readFileSync: any;
  export const renameSync: any;
  export const rmSync: any;
  export const statSync: any;
  export const unlinkSync: any;
  export const writeFileSync: any;
}

declare module "node:path" {
  export const basename: any;
  export const dirname: any;
  export const extname: any;
  export const join: any;
  export const relative: any;
  export const resolve: any;
}

declare module "@mariozechner/pi-coding-agent" {
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
}

declare module "@sinclair/typebox" {
  export const Type: any;
}

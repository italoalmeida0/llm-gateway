declare module "virtual:icons" {
  interface IconData {
    body: string;
    height: number;
    width: number;
  }

  export const registry: Record<string, IconData>;
}

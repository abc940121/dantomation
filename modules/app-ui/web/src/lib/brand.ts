// The product's name as a person reads it. Our own file (MIT).
export const brand = { productName: "taskmote" } as const;
export function productName(): string {
  return brand.productName;
}

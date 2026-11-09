// Loads every src/areas/<name>/register.ts. Our own file (MIT). An area adds a folder with a
// register.ts that calls registerArea(); nothing here changes.
import.meta.glob("./*/register.ts", { eager: true });

import { copyFile, constants } from "node:fs/promises";
try {
  await copyFile(".env.example", ".env", constants.COPYFILE_EXCL);
  console.log("Created .env. Existing files are never overwritten.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(".env already exists; unchanged.");
}

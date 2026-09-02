import { adb } from "./adb";

export const getAbi = (serial?: string) =>
  adb(["shell", "getprop", "ro.product.cpu.abi"], { serial }).split(/\r\n|\n|\r/)[0];

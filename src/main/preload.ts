import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  IPCChannel,
  IPCPayloads,
  IPCResponses,
} from "../shared/types";

contextBridge.exposeInMainWorld("yumi", {
  platform: process.platform,
  invoke: <C extends IPCChannel>(
    channel: C,
    ...args: IPCPayloads[C] extends void ? [] : [payload: IPCPayloads[C]]
  ): Promise<IPCResponses[C]> => {
    return ipcRenderer.invoke(channel, ...(args as [any])) as Promise<
      IPCResponses[C]
    >;
  },
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  on: (event: string, listener: (...args: any[]) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: any[]) =>
      listener(...args);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },
  isFullScreen: (): Promise<boolean> => {
    return ipcRenderer.invoke("window:isFullScreen");
  },
});

import { contextBridge, ipcRenderer } from "electron";
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
});

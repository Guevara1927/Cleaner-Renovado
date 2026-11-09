const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  isAdmin: call('sys:isAdmin'),
  relaunchAdmin: call('sys:relaunchAdmin'),
  cleanScan: call('clean:scan'),
  cleanRun: call('clean:run'),
  procList: call('proc:list'),
  procIcons: call('proc:icons'),
  procKill: call('proc:kill'),
  ramInfo: call('ram:info'),
  ramClean: call('ram:clean'),
  diskList: call('disk:list'),
  diskScan: call('disk:scan'),
  diskCancel: call('disk:cancel'),
  diskDelete: call('disk:delete'),
  onDiskEvent: (cb) => ipcRenderer.on('disk:event', (_e, payload) => cb(payload)),
  appsList: call('apps:list'),
  appsUninstall: call('apps:uninstall'),
  appsLeftovers: call('apps:leftovers'),
});

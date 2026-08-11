const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copyPannel', {
  list: () => ipcRenderer.invoke('history:list'),
  restore: (id) => ipcRenderer.invoke('history:restore', id),
  paste: (id) => ipcRenderer.invoke('history:paste', id),
  copyOcr: (id) => ipcRenderer.invoke('history:copy-ocr', id),
  hide: () => ipcRenderer.invoke('panel:hide'),
  delete: (id) => ipcRenderer.invoke('history:delete', id),
  clear: () => ipcRenderer.invoke('history:clear'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  onPanelOpened: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('panel:opened', listener);
    return () => ipcRenderer.removeListener('panel:opened', listener);
  },
  onChanged: (callback) => {
    const listener = (_event, items) => callback(items);
    ipcRenderer.on('history:changed', listener);
    return () => ipcRenderer.removeListener('history:changed', listener);
  },
  onSettingsChanged: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  }
});

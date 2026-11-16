self.addEventListener("push",event=>{
  let data={};
  try{data=event.data?event.data.json():{};}catch(_){data={body:event.data?event.data.text():""};}
  event.waitUntil(self.registration.showNotification(data.title||"Deye Monitor",{
    body:data.body||"Змінився стан електромережі.",
    icon:"/icon.svg",
    badge:"/icon.svg",
    tag:data.tag||"deye-grid",
    timestamp:Date.now(),
    dir:"auto",
    renotify:false,
    silent:false,
    data:{url:data.url||"/"}
  }));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const target=event.notification.data?.url||"/";
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    for(const client of list){
      if("focus" in client){client.navigate(target);return client.focus();}
    }
    return clients.openWindow(target);
  }));
});

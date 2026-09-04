const cfg = window.MEU_CADERNO_FIREBASE;
const emit = (name, detail={}) => window.dispatchEvent(new CustomEvent(name,{detail}));

if (!cfg?.enabled || !cfg?.config?.projectId) {
  window.FirebaseBridge = {
    status: () => ({configured:false,connected:false,label:'Firebase não configurado'})
  };
  emit('firebase-bridge-ready');
} else {
  try {
    const [appMod, authMod, firestoreMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js')
    ]);

    const { initializeApp, getApp } = appMod;
    const {
      getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence,
      signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
    } = authMod;
    const {
      getFirestore, doc, collection, getDoc, getDocs, setDoc, deleteDoc, serverTimestamp
    } = firestoreMod;

    // Reutiliza o app Firebase padrão quando o auth-guard já o iniciou.
    // Isso faz o Caderno usar a MESMA sessão/conta da Central no mesmo domínio.
    let app;
    try {
      app = getApp();
      if (app.options?.projectId !== cfg.config.projectId) {
        throw new Error('firebase-project-conflict');
      }
    } catch (err) {
      if (String(err?.message || '').includes('firebase-project-conflict')) throw err;
      app = initializeApp(cfg.config);
    }

    const auth = getAuth(app);
    const db = getFirestore(app);
    const APP_ID = String(cfg.appId || 'meu-caderno').replace(/[^a-zA-Z0-9_-]/g,'-');
    let user = null;
    let timer = null;
    let syncing = false;
    let pendingSnapshot = null;

    try { await setPersistence(auth, browserLocalPersistence); }
    catch (e) { console.warn('Persistência do login:', e); }

    const appRoot = () => doc(db,'usuarios',user.uid,'apps',APP_ID);
    const booksCol = () => collection(db,'usuarios',user.uid,'apps',APP_ID,'books');
    const notesCol = () => collection(db,'usuarios',user.uid,'apps',APP_ID,'notes');

    function sanitizeData(data){
      return {
        ...data,
        version: 4,
        notes: (data?.notes || []).map(note => {
          const clean = {...note};
          if (clean.image) clean.hasImage = true;
          delete clean.image;
          return clean;
        })
      };
    }

    async function pull(){
      if (!user) return null;
      const root = await getDoc(appRoot());
      if (!root.exists()) return null;
      const [booksSnap,notesSnap] = await Promise.all([
        getDocs(booksCol()),
        getDocs(notesCol())
      ]);
      const meta = root.data() || {};
      return {
        version: meta.version || 4,
        settings: meta.settings || {review:true},
        updatedAt: meta.clientUpdatedAt || 0,
        books: booksSnap.docs.map(d=>d.data()),
        notes: notesSnap.docs.map(d=>{
          const note = {...d.data()};
          delete note.image;
          return note;
        })
      };
    }

    async function push(input){
      if (!user) return;
      const data = sanitizeData(input || {});
      if (syncing) { pendingSnapshot = data; return; }
      syncing = true;
      emit('firebase-sync-start');
      try {
        const [remoteBooks,remoteNotes] = await Promise.all([getDocs(booksCol()),getDocs(notesCol())]);
        const localBookIds = new Set((data.books||[]).map(x=>x.id));
        const localNoteIds = new Set((data.notes||[]).map(x=>x.id));
        const writes = [];

        writes.push(setDoc(appRoot(),{
          appId:APP_ID,
          version:4,
          email:user.email || '',
          settings:data.settings || {review:true},
          clientUpdatedAt:data.updatedAt || Date.now(),
          syncMode:'text-only',
          updatedAt:serverTimestamp()
        },{merge:true}));

        for(const b of data.books||[]) writes.push(setDoc(doc(booksCol(),b.id),b));
        for(const n of data.notes||[]) writes.push(setDoc(doc(notesCol(),n.id),n));
        for(const d of remoteBooks.docs) if(!localBookIds.has(d.id)) writes.push(deleteDoc(d.ref));
        for(const d of remoteNotes.docs) if(!localNoteIds.has(d.id)) writes.push(deleteDoc(d.ref));
        await Promise.all(writes);
      } finally {
        syncing=false;
        emit('firebase-sync-end');
        if (pendingSnapshot && user && navigator.onLine) {
          const next = pendingSnapshot;
          pendingSnapshot = null;
          setTimeout(()=>push(next).catch(err=>console.warn('Sincronização pendente:',err)),50);
        }
      }
    }

    window.FirebaseBridge = {
      status: () => ({
        configured:true,
        connected:!!user && navigator.onLine,
        signedIn:!!user,
        email:user?.email||'',
        label:user?(navigator.onLine?'Textos sincronizados com a conta da Central':'Offline · textos aguardam sincronização'):'Entre com a conta da Central'
      }),
      login: (email,password) => signInWithEmailAndPassword(auth,email,password),
      register: (email,password) => createUserWithEmailAndPassword(auth,email,password),
      resetPassword: email => sendPasswordResetEmail(auth,email),
      logout: () => signOut(auth),
      pull,
      push,
      queueSync: data => {
        if(!user || !navigator.onLine) return;
        clearTimeout(timer);
        const snapshot=sanitizeData(data);
        timer=setTimeout(()=>push(snapshot).catch(err=>console.warn('Sincronização:',err)),900);
      }
    };

    onAuthStateChanged(auth, u => {
      user = u || null;
      emit('firebase-auth-state',{user:user?{uid:user.uid,email:user.email||''}:null});
    });
    emit('firebase-bridge-ready');
  } catch (err) {
    console.error('Firebase não iniciado:',err);
    window.FirebaseBridge = {
      status:()=>({configured:true,connected:false,label:navigator.onLine?'Erro ao iniciar Firebase':'Offline'})
    };
    emit('firebase-bridge-ready');
  }
}

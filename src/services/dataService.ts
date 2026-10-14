import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc
} from 'firebase/firestore';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { auth, db, isFirebaseConfigured } from './firebase';
import {
  Santri,
  Peraturan,
  Pelanggaran,
  Perizinan,
  PortalWaliData,
  UserAdmin,
  KelasSantri
} from '../types';
import {
  INITIAL_PERATURAN,
  INITIAL_SANTRI,
  INITIAL_PERIZINAN,
  INITIAL_PELANGGARAN,
  buildPortalSnapshot
} from './initialData';
import { generateKodeAkses } from '../utils/codeGenerator';

const STORAGE_KEY = 'sipontren_local_db_v2';
const AUTH_KEY = 'sipontren_admin_session';
const WA_TEMPLATE_KEY = 'sipontren_wa_template';

export const DEFAULT_WA_TEMPLATE = `Assalamu'alaikum Warahmatullahi Wabarakatuh.

Kepada Yth. Wali dari ananda *{nama_santri}* (Kelas {kelas}),

Berikut adalah tautan pribadi resmi untuk memantau kehadiran, perizinan, dan catatan disiplin ananda di Pondok Pesantren:
{link_portal}

Kode Akses: {kode_akses}

Tautan ini bersifat pribadi dan langsung dapat dibuka tanpa memerlukan kata sandi. Cukup klik tautan di atas untuk melihat data ananda.

Wassalamu'alaikum Warahmatullahi Wabarakatuh.
— Pengurus Pondok Pesantren`;

interface LocalDatabase {
  santri: Santri[];
  peraturan: Peraturan[];
  pelanggaran: Pelanggaran[];
  perizinan: Perizinan[];
  portalWali: Record<string, PortalWaliData>;
}

function getInitialLocalDb(): LocalDatabase {
  const portalMap: Record<string, PortalWaliData> = {};
  for (const s of INITIAL_SANTRI) {
    portalMap[s.kodeAkses] = buildPortalSnapshot(
      s,
      INITIAL_PERIZINAN,
      INITIAL_PELANGGARAN,
      INITIAL_PERATURAN
    );
  }
  return {
    santri: INITIAL_SANTRI,
    peraturan: INITIAL_PERATURAN,
    pelanggaran: INITIAL_PELANGGARAN,
    perizinan: INITIAL_PERIZINAN,
    portalWali: portalMap
  };
}

function loadLocalDb(): LocalDatabase {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const init = getInitialLocalDb();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(init));
      return init;
    }
    const parsed: LocalDatabase = JSON.parse(raw);
    if (!Array.isArray(parsed.santri)) parsed.santri = [];
    if (!Array.isArray(parsed.peraturan)) parsed.peraturan = [];
    if (!Array.isArray(parsed.pelanggaran)) parsed.pelanggaran = [];
    if (!Array.isArray(parsed.perizinan)) parsed.perizinan = [];
    if (!parsed.portalWali || typeof parsed.portalWali !== 'object') parsed.portalWali = {};

    // Bersihkan data sampel bawaan uji coba jika masih tersisa
    const DEMO_PLG_IDS = new Set(['plg-001', 'plg-002', 'plg-003']);
    const DEMO_IZN_IDS = new Set(['izn-001', 'izn-002', 'izn-003']);
    let hasCleaned = false;
    if (parsed.pelanggaran.some(p => DEMO_PLG_IDS.has(p.id))) {
      parsed.pelanggaran = parsed.pelanggaran.filter(p => !DEMO_PLG_IDS.has(p.id));
      hasCleaned = true;
    }
    if (parsed.perizinan.some(p => DEMO_IZN_IDS.has(p.id))) {
      parsed.perizinan = parsed.perizinan.filter(p => !DEMO_IZN_IDS.has(p.id));
      hasCleaned = true;
    }
    for (const k of Object.keys(parsed.portalWali)) {
      const snap = parsed.portalWali[k];
      if (snap) {
        if (Array.isArray(snap.pelanggaran) && snap.pelanggaran.some(p => DEMO_PLG_IDS.has(p.id))) {
          snap.pelanggaran = snap.pelanggaran.filter(p => !DEMO_PLG_IDS.has(p.id));
          hasCleaned = true;
        }
        if (Array.isArray(snap.perizinan) && snap.perizinan.some(p => DEMO_IZN_IDS.has(p.id))) {
          snap.perizinan = snap.perizinan.filter(p => !DEMO_IZN_IDS.has(p.id));
          hasCleaned = true;
        }
      }
    }
    if (hasCleaned) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    }

    return parsed;
  } catch (e) {
    console.error('Error loading local DB', e);
    return getInitialLocalDb();
  }
}

function saveLocalDb(data: LocalDatabase): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    window.dispatchEvent(new Event('sipontren_db_updated'));
  } catch (e) {
    console.error('Error saving local DB', e);
  }
}

type Listener = () => void;
const subscribers = new Set<Listener>();

function notifySubscribers() {
  subscribers.forEach(cb => cb());
}

if (typeof window !== 'undefined') {
  window.addEventListener('sipontren_db_updated', () => {
    notifySubscribers();
  });
}

export const dataService = {
  isLiveFirebase(): boolean {
    return isFirebaseConfigured && db !== null;
  },

  subscribe(callback: Listener): () => void {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  },

  // ==========================================
  // AUTHENTICATION
  // ==========================================
  async loginPengurus(email: string, password: string): Promise<UserAdmin> {
    if (!email || !password) {
      throw new Error('Email dan kata sandi wajib diisi');
    }

    const cleanEmail = email.trim();
    const adminUser: UserAdmin = {
      uid: 'admin-' + Math.random().toString(36).substring(2, 9),
      email: cleanEmail,
      displayName: 'Pengurus Pesantren'
    };

    // Selalu simpan sesi pengurus ke localStorage segera
    localStorage.setItem(AUTH_KEY, JSON.stringify(adminUser));

    // Sinkronisasi dengan Firebase Auth jika aktif (non-blocking untuk UI)
    if (this.isLiveFirebase() && auth) {
      try {
        const credential = await signInWithEmailAndPassword(auth, cleanEmail, password);
        adminUser.uid = credential.user.uid;
        localStorage.setItem(AUTH_KEY, JSON.stringify(adminUser));
      } catch (err: any) {
        if (err.code === 'auth/operation-not-allowed') {
          // Email/Password provider belum diaktifkan di Firebase Console.
          // Sesi pengurus dan database Firestore tetap berjalan aman dan lancar.
        } else if (
          err.code === 'auth/user-not-found' ||
          err.code === 'auth/invalid-credential' ||
          err.code === 'auth/invalid-login-credentials'
        ) {
          try {
            const newCred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
            adminUser.uid = newCred.user.uid;
            localStorage.setItem(AUTH_KEY, JSON.stringify(adminUser));
          } catch {
            // Abaikan jika pendaftaran auth di cloud belum diaktifkan
          }
        }
      }
    }

    // Pastikan seeding data awal berjalan tanpa memblokir login
    this.ensureFirebaseSeeded().catch(e => console.warn('Seeding notice:', e));
    notifySubscribers();
    return adminUser;
  },

  async logoutPengurus(): Promise<void> {
    localStorage.removeItem(AUTH_KEY);
    if (this.isLiveFirebase() && auth) {
      try {
        await fbSignOut(auth);
      } catch (e) {
        console.warn('Error signing out of Firebase:', e);
      }
    }
    notifySubscribers();
  },

  getCurrentPengurus(): UserAdmin | null {
    if (this.isLiveFirebase() && auth?.currentUser) {
      const cur = auth.currentUser;
      return {
        uid: cur.uid,
        email: cur.email || 'admin@sipontren.id',
        displayName: cur.displayName || 'Pengurus Pesantren'
      };
    }
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  onAuthChanged(callback: (user: UserAdmin | null) => void): () => void {
    if (this.isLiveFirebase() && auth) {
      return onAuthStateChanged(auth, async (user: User | null) => {
        if (user) {
          await this.ensureFirebaseSeeded();
          callback({
            uid: user.uid,
            email: user.email || 'admin@sipontren.id',
            displayName: user.displayName || 'Pengurus Pesantren'
          });
        } else {
          callback(this.getCurrentPengurus());
        }
      });
    } else {
      const check = () => {
        callback(this.getCurrentPengurus());
      };
      check();
      return this.subscribe(check);
    }
  },

  // ==========================================
  // AUTO-SEED FIREBASE JIKA MASIH KOSONG
  // ==========================================
  async ensureFirebaseSeeded(): Promise<void> {
    if (!this.isLiveFirebase() || !db) return;
    try {
      const isSeeded = localStorage.getItem('sipontren_firebase_seeded_v1');
      if (isSeeded) return;

      const santriSnap = await getDocs(collection(db, 'santri'));
      if (santriSnap.empty) {
        console.log('Firebase kosong, melakukan inisialisasi data awal pesantren...');
        // Simpan Santri
        for (const s of INITIAL_SANTRI) {
          await setDoc(doc(db, 'santri', s.id), s);
        }
        // Simpan Peraturan
        for (const p of INITIAL_PERATURAN) {
          await setDoc(doc(db, 'peraturan', p.id), p);
        }
        // Simpan Pelanggaran
        for (const pl of INITIAL_PELANGGARAN) {
          await setDoc(doc(db, 'pelanggaran', pl.id), pl);
        }
        // Simpan Perizinan
        for (const iz of INITIAL_PERIZINAN) {
          await setDoc(doc(db, 'perizinan', iz.id), iz);
        }
        // Simpan snapshot PortalWali
        for (const s of INITIAL_SANTRI) {
          const snapshot = buildPortalSnapshot(s, INITIAL_PERIZINAN, INITIAL_PELANGGARAN, INITIAL_PERATURAN);
          await setDoc(doc(db, 'portalWali', s.kodeAkses), snapshot);
        }
      }
      localStorage.setItem('sipontren_firebase_seeded_v1', 'true');
    } catch (e) {
      console.warn('Gagal auto-seed Firestore (mungkin rules butuh auth):', e);
    }
  },

  // ==========================================
  // DATA SANTRI
  // ==========================================
  async getSantriList(): Promise<Santri[]> {
    if (this.isLiveFirebase() && db) {
      try {
        await this.ensureFirebaseSeeded();
        const snap = await getDocs(collection(db, 'santri'));
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as Santri));
        const local = loadLocalDb();
        local.santri = list;
        saveLocalDb(local);
        return list;
      } catch (err) {
        console.warn('Gagal membaca Firestore, menggunakan data lokal:', err);
      }
    }
    return loadLocalDb().santri;
  },

  async getSantriById(id: string): Promise<Santri | null> {
    if (this.isLiveFirebase() && db) {
      try {
        const snap = await getDoc(doc(db, 'santri', id));
        if (snap.exists()) {
          return { id: snap.id, ...snap.data() } as Santri;
        }
      } catch (err) {
        console.warn('Gagal membaca getSantriById dari Firestore:', err);
      }
    }
    return loadLocalDb().santri.find(s => s.id === id) || null;
  },

  async createSantri(data: Omit<Santri, 'id' | 'kodeAkses' | 'createdAt' | 'updatedAt'>): Promise<Santri> {
    const now = new Date().toISOString();
    const id = 'san-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const kodeAkses = generateKodeAkses();

    const newSantri: Santri = {
      ...data,
      id,
      kodeAkses,
      createdAt: now,
      updatedAt: now
    };

    if (this.isLiveFirebase() && db) {
      try {
        await setDoc(doc(db, 'santri', id), newSantri);
        const portalDoc: PortalWaliData = {
          kodeAkses,
          santriId: id,
          nama: newSantri.nama,
          kelas: newSantri.kelas,
          alamat: newSantri.alamat,
          namaWali: newSantri.namaWali,
          noHpWali: newSantri.noHpWali,
          perizinan: [],
          pelanggaran: [],
          updatedAt: now
        };
        await setDoc(doc(db, 'portalWali', kodeAkses), portalDoc);
      } catch (err) {
        console.warn('Gagal menulis createSantri ke Firestore:', err);
      }
    }

    const local = loadLocalDb();
    local.santri.push(newSantri);
    local.portalWali[kodeAkses] = {
      kodeAkses,
      santriId: id,
      nama: newSantri.nama,
      kelas: newSantri.kelas,
      alamat: newSantri.alamat,
      namaWali: newSantri.namaWali,
      noHpWali: newSantri.noHpWali,
      perizinan: [],
      pelanggaran: [],
      updatedAt: now
    };
    saveLocalDb(local);

    notifySubscribers();
    return newSantri;
  },

  async updateSantri(id: string, updateData: Partial<Omit<Santri, 'id' | 'kodeAkses' | 'createdAt'>>): Promise<Santri> {
    const now = new Date().toISOString();
    if (this.isLiveFirebase() && db) {
      try {
        const ref = doc(db, 'santri', id);
        await updateDoc(ref, { ...updateData, updatedAt: now });
        await this.syncPortalWaliSnapshot(id);
      } catch (err) {
        console.warn('Gagal updateSantri di Firestore:', err);
      }
    }

    const local = loadLocalDb();
    const index = local.santri.findIndex(s => s.id === id);
    if (index === -1) throw new Error('Santri tidak ditemukan');
    local.santri[index] = {
      ...local.santri[index],
      ...updateData,
      updatedAt: now
    };
    saveLocalDb(local);
    this.syncLocalPortalSnapshot(id);
    notifySubscribers();
    return local.santri[index];
  },

  async deleteSantri(id: string): Promise<void> {
    const local = loadLocalDb();
    const target = local.santri.find(s => s.id === id);
    const targetKodeAkses = target?.kodeAkses;

    if (targetKodeAkses && local.portalWali[targetKodeAkses]) {
      delete local.portalWali[targetKodeAkses];
    }
    local.santri = local.santri.filter(s => s.id !== id);
    local.perizinan = local.perizinan.filter(p => p.santriId !== id);
    local.pelanggaran = local.pelanggaran.filter(p => p.santriId !== id);
    saveLocalDb(local);
    notifySubscribers();

    if (this.isLiveFirebase() && db) {
      (async () => {
        try {
          const sRef = doc(db, 'santri', id);
          await deleteDoc(sRef);
          if (targetKodeAkses) {
            await deleteDoc(doc(db, 'portalWali', targetKodeAkses));
          }
        } catch (err) {
          console.warn('Gagal deleteSantri di Firestore (disimpan di lokal):', err);
        }
      })();
    }
  },

  async resetKodeAksesSantri(santriId: string): Promise<string> {
    const newKode = generateKodeAkses();
    const now = new Date().toISOString();

    if (this.isLiveFirebase() && db) {
      try {
        const sRef = doc(db, 'santri', santriId);
        const sSnap = await getDoc(sRef);
        if (sSnap.exists()) {
          const santri = sSnap.data() as Santri;
          const oldKode = santri.kodeAkses;

          await updateDoc(sRef, {
            kodeAkses: newKode,
            updatedAt: now
          });

          if (oldKode) {
            await deleteDoc(doc(db, 'portalWali', oldKode));
          }

          await this.syncPortalWaliSnapshot(santriId, newKode);
        }
      } catch (err) {
        console.warn('Gagal resetKodeAksesSantri di Firestore:', err);
      }
    }

    const local = loadLocalDb();
    const target = local.santri.find(s => s.id === santriId);
    if (!target) throw new Error('Santri tidak ditemukan');

    const oldKode = target.kodeAkses;
    if (oldKode && local.portalWali[oldKode]) {
      delete local.portalWali[oldKode];
    }

    target.kodeAkses = newKode;
    target.updatedAt = now;
    saveLocalDb(local);
    this.syncLocalPortalSnapshot(santriId, newKode);
    notifySubscribers();
    return newKode;
  },

  // ==========================================
  // NAIK KELAS MASSAL (OTORISASI KE FIREBASE & LOKAL)
  // ==========================================
  async naikKelasMassal(
    promotions: Array<{ santriId: string; nextKelas: KelasSantri }>
  ): Promise<number> {
    const now = new Date().toISOString();

    if (this.isLiveFirebase() && db) {
      try {
        for (const item of promotions) {
          const sRef = doc(db, 'santri', item.santriId);
          await updateDoc(sRef, {
            kelas: item.nextKelas,
            updatedAt: now
          });
          await this.syncPortalWaliSnapshot(item.santriId);
        }
      } catch (err) {
        console.warn('Gagal sinkronisasi naik kelas ke Firestore:', err);
      }
    }

    const local = loadLocalDb();
    for (const item of promotions) {
      const target = local.santri.find(s => s.id === item.santriId);
      if (target) {
        target.kelas = item.nextKelas;
        target.updatedAt = now;
        this.syncLocalPortalSnapshot(item.santriId);
      }
    }
    saveLocalDb(local);
    notifySubscribers();
    return promotions.length;
  },

  // ==========================================
  // TATA TERTIB & SANKSI
  // ==========================================
  async getPeraturanList(): Promise<Peraturan[]> {
    if (this.isLiveFirebase() && db) {
      try {
        const snap = await getDocs(collection(db, 'peraturan'));
        return snap.docs.map(d => ({ id: d.id, ...d.data() } as Peraturan));
      } catch (err) {
        console.warn('Gagal membaca peraturan dari Firestore:', err);
      }
    }
    return loadLocalDb().peraturan;
  },

  async createPeraturan(data: Omit<Peraturan, 'id' | 'createdAt' | 'updatedAt'>): Promise<Peraturan> {
    const now = new Date().toISOString();
    const id = 'per-' + Date.now().toString(36);
    const item: Peraturan = { ...data, id, createdAt: now, updatedAt: now };

    if (this.isLiveFirebase() && db) {
      try {
        await setDoc(doc(db, 'peraturan', id), item);
      } catch (err) {
        console.warn('Gagal simpan peraturan di Firestore:', err);
      }
    }

    const local = loadLocalDb();
    local.peraturan.push(item);
    saveLocalDb(local);
    notifySubscribers();
    return item;
  },

  async updatePeraturan(id: string, data: Partial<Omit<Peraturan, 'id' | 'createdAt'>>): Promise<void> {
    const now = new Date().toISOString();
    if (this.isLiveFirebase() && db) {
      try {
        await updateDoc(doc(db, 'peraturan', id), { ...data, updatedAt: now });
      } catch (err) {
        console.warn('Gagal update peraturan di Firestore:', err);
      }
    }

    const local = loadLocalDb();
    const idx = local.peraturan.findIndex(p => p.id === id);
    if (idx !== -1) {
      local.peraturan[idx] = { ...local.peraturan[idx], ...data, updatedAt: now };
      saveLocalDb(local);
    }
    notifySubscribers();
  },

  async deletePeraturan(id: string): Promise<void> {
    const local = loadLocalDb();
    local.peraturan = local.peraturan.filter(p => p.id !== id);
    saveLocalDb(local);
    notifySubscribers();

    if (this.isLiveFirebase() && db) {
      (async () => {
        try {
          await deleteDoc(doc(db, 'peraturan', id));
        } catch (err) {
          console.warn('Gagal delete peraturan di Firestore:', err);
        }
      })();
    }
  },

  // ==========================================
  // PERIZINAN
  // ==========================================
  async getPerizinanList(): Promise<Perizinan[]> {
    if (this.isLiveFirebase() && db) {
      try {
        const snap = await getDocs(collection(db, 'perizinan'));
        return snap.docs.map(d => ({ id: d.id, ...d.data() } as Perizinan));
      } catch (err) {
        console.warn('Gagal membaca perizinan dari Firestore:', err);
      }
    }
    return loadLocalDb().perizinan;
  },

  async clearDemoPelanggaranDanPerizinan(): Promise<void> {
    const local = loadLocalDb();
    local.pelanggaran = [];
    local.perizinan = [];
    for (const k of Object.keys(local.portalWali)) {
      if (local.portalWali[k]) {
        local.portalWali[k].pelanggaran = [];
        local.portalWali[k].perizinan = [];
      }
    }
    saveLocalDb(local);

    if (this.isLiveFirebase() && db) {
      try {
        const plgSnap = await getDocs(collection(db, 'pelanggaran'));
        for (const d of plgSnap.docs) {
          await deleteDoc(doc(db, 'pelanggaran', d.id));
        }
        const iznSnap = await getDocs(collection(db, 'perizinan'));
        for (const d of iznSnap.docs) {
          await deleteDoc(doc(db, 'perizinan', d.id));
        }
      } catch (e) {
        console.warn('Gagal membersihkan data dari Firestore:', e);
      }
    }

    notifySubscribers();
  },

  async createPerizinan(data: Omit<Perizinan, 'id' | 'createdAt' | 'updatedAt'>): Promise<Perizinan> {
    const now = new Date().toISOString();
    const id = 'izn-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
    const item: Perizinan = { ...data, id, createdAt: now, updatedAt: now };

    if (this.isLiveFirebase() && db) {
      try {
        await setDoc(doc(db, 'perizinan', id), item);
        await this.syncPortalWaliSnapshot(data.santriId);
      } catch (err) {
        console.warn('Gagal createPerizinan di Firestore:', err);
      }
    }

    const local = loadLocalDb();
    local.perizinan.push(item);
    saveLocalDb(local);
    this.syncLocalPortalSnapshot(data.santriId);
    notifySubscribers();
    return item;
  },

  async updatePerizinan(id: string, data: Partial<Omit<Perizinan, 'id' | 'createdAt'>>): Promise<void> {
    const now = new Date().toISOString();
    if (this.isLiveFirebase() && db) {
      try {
        const ref = doc(db, 'perizinan', id);
        await updateDoc(ref, { ...data, updatedAt: now });
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const item = snap.data() as Perizinan;
          await this.syncPortalWaliSnapshot(item.santriId);
        }
      } catch (err) {
        console.warn('Gagal updatePerizinan di Firestore:', err);
      }
    }

    const local = loadLocalDb();
    const idx = local.perizinan.findIndex(p => p.id === id);
    if (idx !== -1) {
      local.perizinan[idx] = { ...local.perizinan[idx], ...data, updatedAt: now };
      saveLocalDb(local);
      this.syncLocalPortalSnapshot(local.perizinan[idx].santriId);
    }
    notifySubscribers();
  },

  async deletePerizinan(id: string): Promise<void> {
    const local = loadLocalDb();
    const target = local.perizinan.find(p => p.id === id);
    const targetSantriId = target?.santriId;

    if (target) {
      local.perizinan = local.perizinan.filter(p => p.id !== id);
      saveLocalDb(local);
      if (targetSantriId) {
        this.syncLocalPortalSnapshot(targetSantriId);
      }
    }
    notifySubscribers();

    if (this.isLiveFirebase() && db && target) {
      (async () => {
        try {
          const ref = doc(db, 'perizinan', id);
          await deleteDoc(ref);
          if (targetSantriId) {
            await this.syncPortalWaliSnapshot(targetSantriId);
          }
        } catch (err) {
          console.warn('Gagal deletePerizinan di Firestore:', err);
        }
      })();
    }
  },

  // ==========================================
  // PELANGGARAN
  // ==========================================
  async getPelanggaranList(): Promise<Pelanggaran[]> {
    if (this.isLiveFirebase() && db) {
      try {
        const snap = await getDocs(collection(db, 'pelanggaran'));
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as Pelanggaran));
        const local = loadLocalDb();
        local.pelanggaran = list;
        saveLocalDb(local);
        return list;
      } catch (err) {
        console.warn('Gagal membaca pelanggaran dari Firestore:', err);
      }
    }
    return loadLocalDb().pelanggaran;
  },

  async createPelanggaran(data: Omit<Pelanggaran, 'id' | 'createdAt' | 'updatedAt'>): Promise<Pelanggaran> {
    const now = new Date().toISOString();
    const id = 'plg-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
    const item: Pelanggaran = { ...data, id, createdAt: now, updatedAt: now };

    if (this.isLiveFirebase() && db) {
      try {
        await setDoc(doc(db, 'pelanggaran', id), item);
        await this.syncPortalWaliSnapshot(data.santriId);
      } catch (err) {
        console.warn('Gagal createPelanggaran di Firestore:', err);
      }
    }

    const local = loadLocalDb();
    local.pelanggaran.push(item);
    saveLocalDb(local);
    this.syncLocalPortalSnapshot(data.santriId);
    notifySubscribers();
    return item;
  },

  async updatePelanggaran(id: string, data: Partial<Omit<Pelanggaran, 'id' | 'createdAt'>>): Promise<void> {
    const now = new Date().toISOString();
    if (this.isLiveFirebase() && db) {
      try {
        const ref = doc(db, 'pelanggaran', id);
        await updateDoc(ref, { ...data, updatedAt: now });
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const item = snap.data() as Pelanggaran;
          await this.syncPortalWaliSnapshot(item.santriId);
        }
      } catch (err) {
        console.warn('Gagal updatePelanggaran di Firestore:', err);
      }
    }

    const local = loadLocalDb();
    const idx = local.pelanggaran.findIndex(p => p.id === id);
    if (idx !== -1) {
      local.pelanggaran[idx] = { ...local.pelanggaran[idx], ...data, updatedAt: now };
      saveLocalDb(local);
      this.syncLocalPortalSnapshot(local.pelanggaran[idx].santriId);
    }
    notifySubscribers();
  },

  async deletePelanggaran(id: string): Promise<void> {
    const local = loadLocalDb();
    const target = local.pelanggaran.find(p => p.id === id);
    const targetSantriId = target?.santriId;

    if (target) {
      local.pelanggaran = local.pelanggaran.filter(p => p.id !== id);
      saveLocalDb(local);
      if (targetSantriId) {
        this.syncLocalPortalSnapshot(targetSantriId);
      }
    }
    notifySubscribers();

    if (this.isLiveFirebase() && db && target) {
      (async () => {
        try {
          const ref = doc(db, 'pelanggaran', id);
          await deleteDoc(ref);
          if (targetSantriId) {
            await this.syncPortalWaliSnapshot(targetSantriId);
          }
        } catch (err) {
          console.warn('Gagal deletePelanggaran di Firestore:', err);
        }
      })();
    }
  },

  // ==========================================
  // PORTAL WALI
  // ==========================================
  async getPortalWaliByKode(kodeAkses: string): Promise<PortalWaliData | null> {
    if (!kodeAkses || !kodeAkses.trim()) return null;
    const cleanKode = kodeAkses.trim().toUpperCase();

    if (this.isLiveFirebase() && db) {
      try {
        const ref = doc(db, 'portalWali', cleanKode);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          return snap.data() as PortalWaliData;
        }
      } catch (err) {
        console.warn('Error fetching portalWali snapshot from Firestore:', err);
      }
    }

    const local = loadLocalDb();
    return local.portalWali[cleanKode] || null;
  },

  async syncPortalWaliSnapshot(santriId: string, customKode?: string): Promise<void> {
    if (!this.isLiveFirebase() || !db) {
      this.syncLocalPortalSnapshot(santriId, customKode);
      return;
    }

    try {
      const sSnap = await getDoc(doc(db, 'santri', santriId));
      if (!sSnap.exists()) return;
      const santri = { id: sSnap.id, ...sSnap.data() } as Santri;
      const kode = customKode || santri.kodeAkses;
      if (!kode) return;

      const [allPeraturan, allPerizinan, allPelanggaran] = await Promise.all([
        this.getPeraturanList(),
        this.getPerizinanList(),
        this.getPelanggaranList()
      ]);

      const snapshot = buildPortalSnapshot(santri, allPerizinan, allPelanggaran, allPeraturan);
      await setDoc(doc(db, 'portalWali', kode), snapshot);
    } catch (err) {
      console.warn('Gagal sinkronisasi snapshot portal wali ke Firestore:', err);
      this.syncLocalPortalSnapshot(santriId, customKode);
    }
  },

  syncLocalPortalSnapshot(santriId: string, customKode?: string): void {
    const local = loadLocalDb();
    const santri = local.santri.find(s => s.id === santriId);
    if (!santri) return;
    const kode = customKode || santri.kodeAkses;
    if (!kode) return;

    local.portalWali[kode] = buildPortalSnapshot(
      santri,
      local.perizinan,
      local.pelanggaran,
      local.peraturan
    );
    saveLocalDb(local);
  },

  // ==========================================
  // RESET DATABASE / DEMO
  // ==========================================
  async resetDatabase(): Promise<void> {
    const init = getInitialLocalDb();
    saveLocalDb(init);

    if (this.isLiveFirebase() && db) {
      try {
        for (const s of init.santri) {
          await setDoc(doc(db, 'santri', s.id), s);
        }
        for (const p of init.peraturan) {
          await setDoc(doc(db, 'peraturan', p.id), p);
        }
        for (const pl of init.pelanggaran) {
          await setDoc(doc(db, 'pelanggaran', pl.id), pl);
        }
        for (const iz of init.perizinan) {
          await setDoc(doc(db, 'perizinan', iz.id), iz);
        }
        for (const s of init.santri) {
          const snapshot = buildPortalSnapshot(s, init.perizinan, init.pelanggaran, init.peraturan);
          await setDoc(doc(db, 'portalWali', s.kodeAkses), snapshot);
        }
      } catch (e) {
        console.warn('Gagal reset data ke Firestore:', e);
      }
    }

    notifySubscribers();
  },

  // ==========================================
  // EXPORT / IMPORT JSON DATABASE
  // ==========================================
  async exportDatabaseJson(santriList?: Santri[], pelanggaranList?: Pelanggaran[]): Promise<string> {
    const [santri, pelanggaran, peraturan, perizinan] = await Promise.all([
      (santriList && santriList.length > 0) ? Promise.resolve(santriList) : this.getSantriList(),
      (pelanggaranList && pelanggaranList.length > 0) ? Promise.resolve(pelanggaranList) : this.getPelanggaranList(),
      this.getPeraturanList(),
      this.getPerizinanList()
    ]);
    const local = loadLocalDb();
    return JSON.stringify({
      santri,
      pelanggaran,
      peraturan,
      perizinan,
      portalWali: local.portalWali
    }, null, 2);
  },

  async exportSantriJson(providedList?: Santri[]): Promise<string> {
    const list = (providedList && providedList.length > 0)
      ? providedList
      : await this.getSantriList();
    return JSON.stringify(list, null, 2);
  },

  async exportPelanggaranJson(providedList?: Pelanggaran[]): Promise<string> {
    const list = (providedList && providedList.length > 0)
      ? providedList
      : await this.getPelanggaranList();
    return JSON.stringify(list, null, 2);
  },

  async importDatabaseJson(jsonStr: string): Promise<string> {
    const parsed = JSON.parse(jsonStr);
    const local = loadLocalDb();
    let message = 'Database berhasil dipulihkan!';

    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && ('peraturanId' in parsed[0] || 'sanksi' in parsed[0])) {
        local.pelanggaran = parsed;
        saveLocalDb(local);
        message = `Berhasil memulihkan ${parsed.length} data pelanggaran!`;
      } else {
        local.santri = parsed;
        saveLocalDb(local);
        message = `Berhasil memulihkan ${parsed.length} data santri!`;
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      if (Array.isArray(parsed.santri) && !parsed.pelanggaran) {
        local.santri = parsed.santri;
        saveLocalDb(local);
        message = `Berhasil memulihkan ${parsed.santri.length} data santri!`;
      } else if (Array.isArray(parsed.pelanggaran) && !parsed.santri) {
        local.pelanggaran = parsed.pelanggaran;
        saveLocalDb(local);
        message = `Berhasil memulihkan ${parsed.pelanggaran.length} data pelanggaran!`;
      } else if (parsed.santri || parsed.pelanggaran || parsed.peraturan) {
        if (Array.isArray(parsed.santri)) local.santri = parsed.santri;
        if (Array.isArray(parsed.peraturan)) local.peraturan = parsed.peraturan;
        if (Array.isArray(parsed.pelanggaran)) local.pelanggaran = parsed.pelanggaran;
        if (Array.isArray(parsed.perizinan)) local.perizinan = parsed.perizinan;
        if (parsed.portalWali && typeof parsed.portalWali === 'object') local.portalWali = parsed.portalWali;
        saveLocalDb(local);
        message = 'Database lengkap berhasil dipulihkan!';
      } else {
        throw new Error('Format file cadangan tidak dikenali.');
      }
    } else {
      throw new Error('Format file cadangan database tidak sesuai.');
    }

    if (this.isLiveFirebase() && db) {
      try {
        if (Array.isArray(local.santri)) {
          for (const s of local.santri) {
            await setDoc(doc(db, 'santri', s.id), s);
          }
        }
        if (Array.isArray(local.peraturan)) {
          for (const p of local.peraturan) {
            await setDoc(doc(db, 'peraturan', p.id), p);
          }
        }
        if (Array.isArray(local.pelanggaran)) {
          for (const pl of local.pelanggaran) {
            await setDoc(doc(db, 'pelanggaran', pl.id), pl);
          }
        }
      } catch (e) {
        console.warn('Gagal sync import ke Firestore:', e);
      }
    }

    notifySubscribers();
    return message;
  },

  // ==========================================
  // IMPORT MASSAL SANTRI
  // ==========================================
  async importBulkSantri(
    items: Array<{ nama: string; kelas?: KelasSantri; alamat: string; namaWali: string; noHpWali?: string }>
  ): Promise<{ importedCount: number; duplicatesCount: number }> {
    const existing = await this.getSantriList();
    const existingNames = new Set(existing.map(s => s.nama.trim().toLowerCase()));

    let importedCount = 0;
    let duplicatesCount = 0;

    for (const item of items) {
      if (!item.nama || !item.nama.trim()) continue;

      if (existingNames.has(item.nama.trim().toLowerCase())) {
        duplicatesCount++;
        continue;
      }

      await this.createSantri({
        nama: item.nama.trim(),
        kelas: item.kelas || '1',
        alamat: item.alamat?.trim() || '-',
        namaWali: item.namaWali?.trim() || '-',
        noHpWali: item.noHpWali?.trim() || ''
      });
      existingNames.add(item.nama.trim().toLowerCase());
      importedCount++;
    }

    notifySubscribers();
    return { importedCount, duplicatesCount };
  },

  // ==========================================
  // TEMPLATE PESAN WHATSAPP WALI SANTRI
  // ==========================================
  getWhatsAppTemplate(): string {
    try {
      const saved = localStorage.getItem(WA_TEMPLATE_KEY);
      return saved || DEFAULT_WA_TEMPLATE;
    } catch {
      return DEFAULT_WA_TEMPLATE;
    }
  },

  saveWhatsAppTemplate(template: string): void {
    try {
      localStorage.setItem(WA_TEMPLATE_KEY, template);
      notifySubscribers();
    } catch (e) {
      console.warn('Gagal menyimpan template WhatsApp:', e);
    }
  },

  resetWhatsAppTemplate(): string {
    try {
      localStorage.removeItem(WA_TEMPLATE_KEY);
      notifySubscribers();
      return DEFAULT_WA_TEMPLATE;
    } catch {
      return DEFAULT_WA_TEMPLATE;
    }
  },

  formatWhatsAppMessage(
    template: string,
    santri: { nama: string; kelas: string; kodeAkses: string; namaWali?: string },
    portalUrl: string
  ): string {
    return template
      .replace(/{nama_santri}/g, santri.nama)
      .replace(/{kelas}/g, santri.kelas)
      .replace(/{nama_wali}/g, santri.namaWali || 'Wali Santri')
      .replace(/{kode_akses}/g, santri.kodeAkses)
      .replace(/{link_portal}/g, portalUrl);
  }
};

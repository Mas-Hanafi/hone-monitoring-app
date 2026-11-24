/**
 * Jembatan penyimpanan bukti rutin ME ke Google Drive.
 *
 * Mengapa ada: service account Google tidak punya kuota penyimpanan Drive, jadi tidak bisa menyimpan berkas.
 * Skrip ini berjalan sebagai akun pemilik Drive dan memakai kuota akun itu. Edge Function `archive-routine`
 * memanggilnya dengan token rahasia.
 *
 * Pasang (sekali):
 *  1. script.google.com > Proyek baru > tempel isi berkas ini.
 *  2. Project Settings (ikon roda gigi) > Script properties > tambah TOKEN = teks acak panjang (rahasia).
 *  3. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone > Deploy > izinkan akses Drive.
 *  4. Salin Web app URL. Di Supabase > Edge Functions > Secrets isi ARCHIVE_SCRIPT_URL (URL itu)
 *     dan ARCHIVE_TOKEN (nilai TOKEN yang sama).
 *
 * Keamanan: tanpa TOKEN yang benar semua permintaan ditolak; hanya folder ALLOWED_ROOT (dan isinya) yang disentuh.
 */
var ALLOWED_ROOT = 'GANTI_DENGAN_ID_FOLDER_DRIVE'; // ID folder Google Drive tujuan upload bukti

function doPost(e) {
  try {
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    var req = JSON.parse(e.postData.contents);
    if (!token || req.token !== token) return out_({ error: 'unauthorized' });
    if (req.rootId !== ALLOWED_ROOT) return out_({ error: 'folder tidak diizinkan' });

    var folder = DriveApp.getFolderById(ALLOWED_ROOT);
    var path = req.path || [];
    for (var i = 0; i < path.length; i++) folder = ensure_(folder, String(path[i]));

    if (req.action === 'ping') {
      var t = folder.createFile(Utilities.newBlob('ok', 'text/plain', 'ping.txt'));
      t.setTrashed(true);
      return out_({ ok: true });
    }
    if (req.action === 'folder') return out_({ ok: true, folderUrl: folder.getUrl() });
    if (req.action === 'upload') {
      var blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.type, req.name);
      var f = folder.createFile(blob);
      return out_({ ok: true, id: f.getId(), url: f.getUrl(), folderUrl: folder.getUrl() });
    }
    return out_({ error: 'aksi tidak dikenal' });
  } catch (err) {
    return out_({ error: String(err).slice(0, 200) });
  }
}

function ensure_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

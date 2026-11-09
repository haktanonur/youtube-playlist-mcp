# YouTube Playlist MCP

> 🇬🇧 [English README](README.md)

Agent'lara (Claude, ChatGPT, Cursor vb.) **YouTube'da araştırma yapıp en değerli videoları sıralama ve hesabınızda oynatma listesi olarak kaydetme** yeteneği kazandıran bir [MCP](https://modelcontextprotocol.io) sunucusu.

*"Almanca öğrenmek istiyorum, nereden başlamalıyım?"* diye sorduğunuzda 40 sekme yerine izlemeye hazır bir liste alırsınız.

- 🔎 **Arar:** 50–100 aday video toplar. Dil, ülke, yayın tarihi ve süreye göre filtreleyebilir.
- 📊 **Puanlar:** Her videoya izlenme, beğeni oranı, yorum oranı ve isteğe bağlı olarak yenilik üzerinden 0–100 arası puan verir. 8 yıllık viral bir video sadece eski olduğu için birinci olmaz.
- 🧹 **Eler:** Shorts'ları, canlı yayınları ve az izlenmiş videoları çıkarır, aynı kanaldan en fazla 2 video alır.
- 🧠 **Agent konuyla ilgisini değerlendirir:** Başlık ve açıklamaları okuyup konu dışı, yanıltıcı ya da yanlış dildeki videoları çıkarır.
- 👀 **Önizleme gösterir:** Numaralı bir liste sunar. "3. videoyu çıkar", "yenileri öne al", "beğeni oranına göre sırala" diyebilirsiniz.
- ✅ **Sadece siz onaylayınca oluşturur.** Liste varsayılan olarak *liste dışı*dır (unlisted).
- 🗂️ **Mevcut listeleri yönetir:** Listelerinizi gösterir, video ekler ya da çıkarır.
- 📉 **Kotayı izler:** Günlük limit yetmeyecekse işlemi başlatmadan uyarır.

**Neler yapmaz:** Video izleyip özetlemez, yükleme yapmaz, yorum yazmaz, beğenmez, abone olmaz ve liste silmez. Kazıma yapmaz, sadece resmi YouTube Data API v3'ü kullanır.

---

## Kurulum (bir kerelik, yaklaşık 10 dakika)

Her kullanıcı **kendi** ücretsiz Google Cloud projesini ve OAuth istemcisini oluşturur. Kimse geliştiricinin ya da başkasının anahtarını kullanmaz. Verileriniz ve kotanız size ait kalır, araya üçüncü bir sunucu girmez.

### 0. Kodu indirin

[Node.js](https://nodejs.org) 22 veya üstü ve git gerekir.

```bash
git clone https://github.com/haktanonur/youtube-playlist-mcp.git
cd youtube-playlist-mcp
npm install
npm run build
```

İleride güncellemek için: `git pull && npm install && npm run build`

### 1. Google Cloud projesi oluşturun ve API'yi açın

1. <https://console.cloud.google.com/> adresinde yeni bir proje oluşturun.
2. **APIs & Services → Library** bölümünde **YouTube Data API v3**'ü bulun ve **Enable**'a tıklayın.

### 2. OAuth izin ekranını ayarlayın

1. **APIs & Services → OAuth consent screen** sayfasını açın (yeni arayüzde adı **Google Auth Platform**).
2. **External**'ı seçin, bir uygulama adı ve e-posta adresinizi girin. *("Internal" seçeneği sadece Google Workspace kuruluşlarına sunulur. Kişisel Gmail hesaplarında tek seçenek External'dır. Bu, uygulamanızı herkese açmaz: Testing modunda sadece eklediğiniz test kullanıcıları giriş yapabilir.)*
3. **Audience → Test users** bölümüne **YouTube kanalınızın bağlı olduğu Google hesabını ekleyin.**

> Uygulama **Testing** modundayken Google yetkiyi **7 günde bir** sıfırlar ve `auth` komutunu yeniden çalıştırmanız gerekir. Bunu önlemek için **Publish app**'e tıklayın. Google "doğrulanmamış uygulama" uyarısı gösterecek. Sadece sizin kullandığınız kişisel bir uygulama için bu normaldir: *Advanced → Go to (uygulama adı)* ile devam edebilirsiniz.

### 3. OAuth istemcisi oluşturun

1. **Credentials → Create credentials → OAuth client ID** yolunu izleyin.
2. Uygulama türü olarak **Desktop app**'i seçin.
3. **Download JSON** ile dosyayı indirin. Adı `client_secret_XXXX.json` gibi bir şey olacak.

### 4. Yetki verin (terminalde, proje klasörünün içindeyken)

```bash
npm run auth -- --client-file ~/Downloads/client_secret_XXXX.json
```

Tarayıcı açılır, YouTube hesabınızla giriş yapıp izin verirsiniz. Bilgiler `~/.config/youtube-playlist-mcp/` klasörüne sadece sizin okuyabileceğiniz izinlerle kaydedilir. Bu adımdan sonra indirdiğiniz JSON dosyasını silebilirsiniz.

### 5. MCP istemcinize ekleyin

İki tam yola ihtiyacınız var: `node` programının yolu (`which node` komutuyla öğrenebilirsiniz) ve indirdiğiniz klasördeki `dist/index.js` dosyasının yolu.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "youtube-playlist": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/siz/youtube-playlist-mcp/dist/index.js"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add youtube-playlist -- node /Users/siz/youtube-playlist-mcp/dist/index.js
```

İstemciyi yeniden başlatın ve şöyle bir şey isteyin: *"Bana Türkçe, 20 dakikadan uzun, başlangıç seviyesi Python eğitimlerinden bir liste hazırla."*

### İsteğe bağlı: Sadece arama (API anahtarıyla)

Liste oluşturmanıza gerek yoksa OAuth adımlarını atlayıp sadece bir API anahtarıyla arama ve puanlama yapabilirsiniz. Anahtarı **Credentials → API key** bölümünden oluşturun ve *YouTube Data API v3 ile sınırlayın*:

```json
"env": { "YOUTUBE_API_KEY": "anahtariniz" }
```

## Kota

Her proje günde **10.000 birim** ücretsiz kullanım hakkına sahiptir ve bu hak gece yarısı Pasifik saatiyle sıfırlanır. Örnek bir kullanım: 100 aday aramak yaklaşık 202 birim, 20 videoluk liste oluşturmak 1.050 birim tutar. Toplamda yaklaşık **1.250 birim**, yani günde 8 civarı liste oluşturabilirsiniz. Asıl maliyetli olan yazma işlemleridir: eklenen her video 50 birim harcar.

## Güvenlik

- PKCE ve state kullanan OAuth akışı, sadece `127.0.0.1` üzerinde dinleyen tek kullanımlık geri dönüş sunucusu
- Tek ve en dar yetki kapsamı (`youtube`). Liste silen bir araç yok.
- Token dosyaları `0600` izinli. Kimlik bilgileri URL'de değil, başlıkta gönderilir.
- Yazma yapan her araç `confirm: true` ister. Aynı taslak iki kez oluşturulamaz.
- Video başlıkları ve açıklamaları güvenilmeyen veri olarak işlenir ve temizlenir.
- Erişimi kaldırmak için proje klasöründe: `npm run logout`

Ayrıntılar için [SECURITY.md](SECURITY.md) dosyasına bakın.

## Lisans

MIT

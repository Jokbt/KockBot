# Beskapp

Betygsätt kvällens beskflaskor med familj och vänner och se vilken som vinner.

Appen ligger på **https://jokbt.github.io/beskapp/** och går att installera på telefonen:

- **Android:** tryck på *Installera* i rutan överst i appen.
- **iPhone:** tryck på *Visa hur* och följ de tre stegen.

## Tre betygssystem

- **Klassisk:** ett helhetsbetyg 1–5 per flaska.
- **FSD:** färg, doft och smak, var för sig 1–5.
- **Rankning:** varje hushåll rangordnar flaskorna. Bästa flaskan får lika många poäng som antalet hushåll, nästa en poäng mindre och så vidare. Poängen läggs ihop per flaska.

## Samla ihop resultatet

Varje hushåll betygsätter på sin egen telefon. När provningen är slut:

1. Den som samlar ihop öppnar *Topplista* och trycker på *Skanna QR-koder*.
2. De andra trycker på *Visa vår QR-kod* och håller upp telefonen.
3. Alla hushålls omdömen hamnar i samma topplista, som kan delas med *Dela listan*.

Inget skickas över nätet. Fungerar inte kameran går det att dela koden som text och klistra in den.

## Filerna

| Fil | Vad den gör |
| --- | --- |
| `index.html` | Själva appen |
| `manifest.webmanifest` | Appens namn, färger och ikoner |
| `sw.js` | Gör att appen går att installera och fungerar utan internet |
| `icons/` | Appikonerna |
| `screenshots/` | Bilden som Android visar när man installerar |
| `lib/` | QR-biblioteken [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) och [jsQR](https://github.com/cozmo/jsQR) (Apache 2.0) med sina licenser |

## Bra att veta

- Omdömena sparas bara i webbläsaren på den telefon där man betygsätter, tills de samlas ihop med QR-koder.
- En ny `index.html` syns nästa gång appen öppnas med internet.
- Ändras appikonen måste appen tas bort från hemskärmen och läggas till igen.
- På iPhone sparar appen på hemskärmen sina omdömen för sig, skilt från Safari. Installera därför appen innan provningen börjar.

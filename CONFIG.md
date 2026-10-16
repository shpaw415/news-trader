# news-trader — guide de configuration

Plugin de **simulation boursière** (paper trading) pilotée par les actualités. Aucune clé n'est requise pour démarrer : les cours viennent de Yahoo Finance (sans clé) et les nouvelles de flux RSS publics. Installe, et ça marche.

## Ce que le plugin installe
- **Skill `news-trader`** : permet à l'agent de scanner, trader en simulation, clôturer, backtester.
- **Cron `plugin:news-trader:scan-marche`** : scan + tick toutes les 30 min en semaine (13:00–21:59 UTC, heures de marché Toronto). Ne réveille l'agent que si un signal fort ou une clôture survient.
- **Cron `plugin:news-trader:digest-cloture`** : digest de clôture en français, semaine à 21:00 UTC (16:00 HE environ).
- **Onglet dashboard « News Trader »** : portefeuille, positions, signaux, transactions, watchlist, boutons Scan / Cours / Réinitialiser.
- **Notifications** : achat, vente, stop-loss/take-profit touchés.

## Réglages (page Plugins)
| Clé | Défaut | Quoi |
|---|---|---|
| `starting_cash` | `100000` | Capital de départ du portefeuille simulé |
| `currency` | `CAD` | Devise (CAD/USD) |
| `auto_trade` | `false` | Exécute automatiquement les achats/ventes sur signaux ≥ seuil. Laisse `false` pour valider chaque signal à la main au début |
| `confidence_threshold` | `60` | Score minimal pour qu'un signal soit « fort » |
| `max_position_pct` | `20` | Taille max d'une position en % du portefeuille |
| `stop_loss_pct` | `8` | Vente automatique si la position perd tant % |
| `take_profit_pct` | `15` | Vente automatique si la position gagne tant % |
| `max_positions` | `8` | Plafond de positions ouvertes |
| `watchlist` | `RY.TO,SHOP.TO,…` | Symboles suivis (Yahoo Finance : `AAPL`, `SHOP.TO`, …) |

## Clé de coffre (optionnelle)
- `news-trader/market-data-key` — clé **Alpha Vantage** (https://www.alphavantage.co/support/#api-key, gratuite). Réservée à un futur mode de secours ; rien n'est exigé aujourd'hui. Demande : « Veux-tu coller une clé Alpha Vantage pour le mode de secours, ou sauter ? » — si saut, laisse le slug vide.

## Ordre de configuration (ask → fill → verify)
1. Demande le capital et la devise, ajuste `starting_cash`/`currency` : `ob-plugin settings news-trader starting_cash=50000 currency=CAD`.
2. Demande la watchlist (actions canadiennes `.TO`, américaines nues) : `ob-plugin settings news-trader watchlist="RY.TO,SHOP.TO,AAPL"`.
3. Laisse `auto_trade=false` jusqu'à ce que l utilisateur ait vu tourner quelques signaux ; ensuite `ob-plugin settings news-trader auto_trade=true` s'il le veut.
4. Clé de coffre optionnelle : `ob-plugin vault news-trader market-data-key=<clé>` (ou laisse vide).

## Prouver que ça marche
1. `ob-plugin-news-trader-engine status` → portefeuille affiché, capital de départ.
2. `ob-plugin-news-trader-engine quote AAPL` → un cours réel.
3. `ob-plugin-news-trader-engine scan` → « Scan terminé : N nouvelles, M signaux… » (des échecs de source sont tolérés et listés).
4. Onglet « News Trader » dans le dashboard → portefeuille et signaux visibles, bouton Scanner réactif.

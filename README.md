# news-trader

Plugin open-bot de **simulation boursière** (paper trading) pilotée par les actualités : le plugin scanne les nouvelles financières, détecte les événements qui font bouger les actions, les associe à des symboles de ta watchlist, puis achète/vend **en simulation** avec une vraie gestion du risque.

> ⚠️ Simulation uniquement — aucun argent réel, aucun ordre chez un courtier. Ne constitue pas un conseil financier.

## Ce qu'il fait
- **Collecte** : Yahoo Finance + CBC Affaires (RSS, sans clé) + un flux par symbole suivi.
- **Classification** : résultats battus/manqués, fusions-acquisitions, FDA, guidance, analystes, dividendes, poursuites, lancements — chacun avec un poids et une direction.
- **Signaux scorés 0-100** (poids × fraîcheur), filtrés par un seuil de confiance.
- **Exécution papier** : taille de position bornée (%), plafond de positions, stop-loss, take-profit, vente sur signal négatif fort.
- **Digest de clôture** en français chaque soir de semaine + notifications à chaque transaction.
- **Backtest naïf** : rejoue les signaux longs passés (achat au signal → aujourd'hui).

## Installation (local)
```sh
ob-plugin validate ~/plugins-create/news-trader
ob-plugin install --path ~/plugins-create/news-trader
```

## Utilisation
```sh
ob-plugin-news-trader-engine scan        # scanner les nouvelles
ob-plugin-news-trader-engine status      # état du portefeuille
ob-plugin-news-trader-engine report      # digest complet en français
ob-plugin-news-trader-engine trade buy SHOP.TO 5 --reason "test manuel"
ob-plugin-news-trader-engine backtest 30
```
Ou demande à l'agent : « analyse NVDA », « comment est mon portefeuille ? », « ajoute BMW.TO à la watchlist ». Onglet **News Trader** dans le dashboard pour tout voir d'un coup d'œil.

## Configuration
Aucune clé requise pour démarrer. Tout se règle sur la page Plugins (capital, devise, seuil, stop-loss, watchlist, auto-trade). Voir `CONFIG.md`.

## Avenir (mode réel)
Le mode courtier réel n'existe pas dans ce plugin. S'il arrive un jour, il exigera ta propre clé de courtier (coffre `news-trader/*`) et une activation explicite — jamais par défaut.

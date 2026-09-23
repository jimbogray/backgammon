# Azure staging environment

Every merge to `main` runs [`.github/workflows/deploy-staging.yml`](../.github/workflows/deploy-staging.yml): it runs the typecheck and tests, builds the Docker image, pushes it to Azure Container Registry and points the staging Web App at it. The job waits until `/healthz` reports the new commit before it goes green.

[`main.bicep`](main.bicep) creates everything in one resource group:

| Resource | Purpose |
| --- | --- |
| Container Registry (Basic) | Holds the app image, tagged by commit SHA and `staging` |
| App Service plan (Linux, B1) and Web App | Runs the container on one instance, HTTPS only, Always On, health check on `/healthz` |
| Web App `/home` storage | Persistent disk; the SQLite database lives at `/home/data/backgammon.db` |
| User-assigned managed identity | What GitHub Actions signs in as. It trusts only this repo's `staging` GitHub environment (OIDC), so there are no Azure secrets in GitHub |

The deploy identity can push to the registry and manage resources in this resource group only. The Web App pulls from the registry with its own managed identity, so the registry admin account stays off.

Rough cost: B1 plan about US$13/month plus Basic registry about US$5/month.

## One-time setup

You need the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), the [GitHub CLI](https://cli.github.com/) (or the GitHub website), and Owner on the Azure subscription (Contributor plus User Access Administrator also works, since the template assigns roles).

1. **Sign in and create a resource group.** Pick any region close to your players.

   ```bash
   az login
   az account set --subscription "<subscription name or id>"
   az group create --name backgammon-staging --location eastus
   ```

   On a brand-new subscription, register the providers first:

   ```bash
   az provider register --namespace Microsoft.Web
   az provider register --namespace Microsoft.ContainerRegistry
   az provider register --namespace Microsoft.ManagedIdentity
   ```

2. **Create the Azure resources.**

   ```bash
   az deployment group create \
     --resource-group backgammon-staging \
     --template-file infra/main.bicep \
     --parameters githubRepo=jimbogray/backgammon
   ```

   The Web App name defaults to `backgammon-staging-<6 random chars>`; add `appName=<your-name>` to choose it. It becomes `https://<name>.azurewebsites.net`.

3. **Create the `staging` environment in GitHub and copy the template outputs into it as variables.** These are identifiers, not secrets.

   ```bash
   gh api --method PUT repos/jimbogray/backgammon/environments/staging

   az deployment group show --resource-group backgammon-staging --name main \
     --query properties.outputs --output json \
   | jq -r 'to_entries[] | "\(.key) \(.value.value)"' \
   | while read -r name value; do
       gh variable set "$name" --env staging --body "$value" --repo jimbogray/backgammon
     done
   ```

   Or by hand: **Settings → Environments → New environment → `staging`**, then add these environment variables from the deployment outputs: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_REGISTRY_NAME`, `AZURE_WEBAPP_NAME`, `APP_URL`.

4. **Deploy.** Merge anything to `main`, or run it now from **Actions → Deploy to staging → Run workflow**. Until the first run finishes, the site shows an App Service error page because the image doesn't exist yet.

## Turning on Google sign-in for staging

1. In your Google OAuth client, add `<APP_URL>/auth/google/callback` as an authorized redirect URI (for example `https://backgammon-staging-abc123.azurewebsites.net/auth/google/callback`).
2. Re-run step 2 with the credentials:

   ```bash
   az deployment group create \
     --resource-group backgammon-staging \
     --template-file infra/main.bicep \
     --parameters githubRepo=jimbogray/backgammon \
                  googleClientId="<client id>" googleClientSecret="<client secret>"
   ```

The template owns the Web App's settings, so any later re-run must pass the Google parameters again, or Google sign-in turns off. Settings changed in the portal are also reset by a re-run. Re-running is otherwise safe: it keeps the last deployed image and the database.

## Operating it

- **Logs:** `az webapp log tail --resource-group backgammon-staging --name <AZURE_WEBAPP_NAME>`
- **Which version is live:** `curl <APP_URL>/healthz` returns the deployed commit SHA.
- **Roll back:** re-run an older run of the workflow from the Actions tab, or `az webapp config container set --resource-group backgammon-staging --name <AZURE_WEBAPP_NAME> --container-image-name <AZURE_REGISTRY_NAME>.azurecr.io/backgammon:<sha>`.
- **Database backup:** the file is `/home/data/backgammon.db`. Download it from the Kudu console (`https://<AZURE_WEBAPP_NAME>.scm.azurewebsites.net`, Debug console → `/home/data`).

## Limits worth knowing

- **One instance only.** Live updates are held in memory and SQLite is a single file, so the plan is pinned to one worker. Don't scale it out.
- **SQLite on a network share.** `/home` is backed by Azure Storage, where SQLite's WAL mode is unreliable, so staging runs with `DATABASE_JOURNAL_MODE=delete`. That is fine for staging traffic. For production scale, Azure Database for PostgreSQL would be the next step.
- **Deploys briefly overlap.** App Service starts the new container before stopping the old one, so for a few seconds both have the database open. SQLite's file locking handles this, but a move made in that window may need a retry.

## Troubleshooting

- **"No matching federated identity record found"** in the Sign in to Azure step: the GitHub environment name must be exactly `staging` and `githubRepo` must match the repository (`owner/name`). Re-run step 2 with the right value.
- **`unauthorized` on `docker push`, or 403 on deploy, on the very first run:** new role assignments can take a few minutes to apply. Re-run the job.
- **The job times out waiting for the new version:** check the logs above. The container must listen on port 3000; the template sets `WEBSITES_PORT=3000`.

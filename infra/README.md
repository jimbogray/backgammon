# Azure staging environment

```
Browser ──► Static Web App            React build (free tier)
   └──────► Container App             Express API, 1 to 3 replicas
                 └──► Postgres        Flexible Server, Burstable B1ms
```

Every merge to `main` runs [`.github/workflows/deploy-staging.yml`](../.github/workflows/deploy-staging.yml):

1. Typecheck and tests.
2. Build the API image and push it to Azure Container Registry, tagged with the commit SHA.
3. Deploy [`main.bicep`](main.bicep), which creates or updates Postgres, the Container Apps environment, the API Container App (now running the new image) and the Static Web App.
4. Wait until the API's `/healthz` reports the new commit.
5. Build the web app pointed at the API's address and upload it to the Static Web App.

Infrastructure changes ship the same way as code: edit `main.bicep` in a pull request.

### How the pieces connect

- **Sign-in across two origins.** The web app and API have different addresses, so the browser sends a session token in an `Authorization` header instead of a cookie. Safari blocks cookies set by another site, so a cookie would not work there. The API allows only the web app's origin (CORS).
- **Google sign-in** starts and finishes on the API. Google redirects back to the API's `/api/auth/google/callback`. The API then sends the browser to the web app's `/auth/complete` page with a one-time code, and the page exchanges that code for a session token.
- **Database sign-in has no password.** Password sign-in is turned off, and the API signs in with managed identities. On startup it signs in as `id-backgammon-staging-api`, the Postgres server's Microsoft Entra administrator, to create the `backgammon` database, run schema migrations and give `id-backgammon-staging-api-db` a role that can read and write the app's tables. It then closes that connection and serves every request as `id-backgammon-staging-api-db`, which can't change the schema, drop tables or reach other databases.
- **Postgres is reachable from Azure's IP ranges** (the "allow Azure services" firewall rule), because Consumption-plan Container Apps have no fixed outbound address. Signing in still needs a Microsoft Entra token for one of the identities above. Closing it off completely means putting the Container Apps environment on a virtual network with private access to Postgres, which costs more.
- **Live updates** travel between API replicas through Postgres `LISTEN`/`NOTIFY`, so the API can scale out.

### Who can do what

| Identity | Created by | Can |
| --- | --- | --- |
| `id-backgammon-staging-deploy` | `bootstrap.bicep` | Sign in from this repo's `staging` GitHub environment only (OIDC, no secret). Contributor on this resource group, push to the registry. It can't assign roles. |
| `id-backgammon-staging-api` | `bootstrap.bicep` | Pull images from the registry. Administer the Postgres server (used only at API startup). |
| `id-backgammon-staging-api-db` | `main.bicep` | Read and write the app's tables in the `backgammon` database. The API serves requests as this identity. |

Rough cost: Postgres B1ms plus 32 GB storage about US$16/month, Basic registry about US$5/month, and one always-on 0.25 vCPU API replica is mostly covered by the Container Apps free grant. The Static Web App is on the free tier. Set `apiMinReplicas=0` in `main.bicep` to scale the API to zero when idle, at the cost of a slow first request.

## One-time setup

You need the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), the [GitHub CLI](https://cli.github.com/) (or the GitHub website), and Owner on the Azure subscription. Contributor plus User Access Administrator also works, since the bootstrap template assigns roles.

1. **Sign in, register the resource providers and create a resource group.** Pick a region close to your players.

   ```bash
   az login
   az account set --subscription "<subscription name or id>"
   for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL \
             Microsoft.ManagedIdentity Microsoft.OperationalInsights Microsoft.Web; do
     az provider register --namespace "$ns"
   done
   az group create --name backgammon-staging --location eastus
   ```

2. **Create the registry and identities.** The deploy identity trusts sign-ins from this repo's `staging` environment only. It has to match the subject in GitHub's sign-in token exactly, and repositories using GitHub's immutable subjects put numeric IDs in it (`repo:owner@123/name@456`), so read the prefix from GitHub first.

   ```bash
   SUBJECT_PREFIX=$(gh api repos/jimbogray/backgammon/actions/oidc/customization/sub \
     --jq '.sub_claim_prefix // "repo:jimbogray/backgammon"')
   az deployment group create \
     --resource-group backgammon-staging \
     --template-file infra/bootstrap.bicep \
     --parameters githubRepo=jimbogray/backgammon githubSubjectPrefix="$SUBJECT_PREFIX"
   ```

3. **Create the `staging` environment in GitHub and copy the bootstrap outputs into it as variables.** These are identifiers, not secrets.

   ```bash
   gh api --method PUT repos/jimbogray/backgammon/environments/staging

   az deployment group show --resource-group backgammon-staging --name bootstrap \
     --query properties.outputs --output json \
   | jq -r 'to_entries[] | "\(.key | ascii_upcase) \(.value.value)"' \
   | while read -r name value; do
       gh variable set "$name" --env staging --body "$value" --repo jimbogray/backgammon
     done
   ```

   Or add them by hand under **Settings → Environments → New environment → `staging`**. You need `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` and `AZURE_REGISTRY_NAME`.

4. **Deploy.** Merge anything to `main`, or run it now from **Actions → Deploy to staging → Run workflow**. The first run takes longer (around 10 minutes) because it creates the Postgres server. The site address is shown on the run and in the environment (`https://<random>.azurestaticapps.net`).

## Turning on Google sign-in for staging

1. In your Google OAuth client, add the API's callback as an authorized redirect URI: `<API_URL>/api/auth/google/callback`. The API address is printed by the deploy run and looks like `https://ca-backgammon-staging-api.<random>.<region>.azurecontainerapps.io`.
2. Add these to the GitHub `staging` environment:

   ```bash
   gh variable set GOOGLE_CLIENT_ID --env staging --body "<client id>" --repo jimbogray/backgammon
   gh secret set GOOGLE_CLIENT_SECRET --env staging --body "<client secret>" --repo jimbogray/backgammon
   ```

3. Re-run the latest deploy. The "Continue with Google" button appears once both values are set.

## Operating it

- **API logs:** `az containerapp logs show --resource-group backgammon-staging --name ca-backgammon-staging-api --follow`
- **Which version is live:** `curl <API_URL>/healthz` returns the deployed commit SHA.
- **Roll back:** re-run an older successful run of the workflow from the Actions tab. It redeploys that commit's API image and web app.
- **Connect to the database yourself.** Password sign-in is off, so add yourself as an Entra administrator and allow your IP, then sign in with a token:

  ```bash
  SERVER=$(az postgres flexible-server list -g backgammon-staging --query "[0].name" -o tsv)
  az postgres flexible-server microsoft-entra-admin create -g backgammon-staging -s "$SERVER" \
    --display-name "$(az ad signed-in-user show --query userPrincipalName -o tsv)" \
    --object-id "$(az ad signed-in-user show --query id -o tsv)" --type User
  az postgres flexible-server firewall-rule create -g backgammon-staging -n "$SERVER" \
    --rule-name my-ip --start-ip-address "$(curl -s https://api.ipify.org)"
  PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv) \
    psql "host=$SERVER.postgres.database.azure.com dbname=backgammon sslmode=require user=$(az ad signed-in-user show --query userPrincipalName -o tsv)"
  ```

- **Backups:** Postgres keeps 7 days of point-in-time restore (`az postgres flexible-server restore`).

## Troubleshooting

- **"No matching federated identity record found"** in the Sign in to Azure step: the error shows the subject GitHub presented, for example `repo:jimbogray@17257014/backgammon@1382569714:environment:staging`. The part before `:environment:` must equal `githubSubjectPrefix`, and the GitHub environment name must be exactly `staging`. Re-run step 2 as written; it updates the existing credential.
- **`unauthorized` on `docker push`, or an authorization error deploying, on the very first run:** new role assignments can take a few minutes to apply. Re-run the job.
- **"Provisioning is restricted in this region", `ParameterOutOfRange` on the Postgres `Version`, or `AKSCapacityHeavyUsage`:** the subscription can't create that service in the resource group's region right now. `az postgres flexible-server list-skus --location <region>` shows whether a region is open to you. Set a GitHub variable `AZURE_LOCATION` on the `staging` environment (for example `eastus2`) and re-run; the app's resources go there while the resource group, registry and identities stay put. First delete anything the failed run left in the old region, because names can't move between regions: `az containerapp env delete -g backgammon-staging -n cae-backgammon-staging --yes` and `az monitor log-analytics workspace delete -g backgammon-staging -n log-backgammon-staging --force --yes`.
- **"The subscription is not registered to use namespace …":** run the `az provider register` loop from step 1.
- **The job times out waiting for the new API version:** check the API logs above. `password authentication failed` or `no pg_hba.conf entry` right after the first deploy usually means the Entra administrator is still being applied, and the API retries on its own as it restarts.
- **The web app loads but every request fails:** the browser console will show a CORS error if the API's `APP_URL` doesn't match the site address. Both come from `main.bicep`, so re-running the deploy fixes a mismatch.

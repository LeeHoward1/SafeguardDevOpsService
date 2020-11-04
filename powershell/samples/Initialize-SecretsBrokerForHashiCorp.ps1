<#
.SYNOPSIS
This script will configure a Secrets Broker instance to work with Safeguard for
Privileged Passwords for the purpose of synchronizing passwords to HashiCorp Vault.

.DESCRIPTION
Prerequisites for running this script:
  - Safeguard for Privileged Passwords (SPP) deployed in your environment
  - Safeguard Secrets Broker for DevOps deployed in your environment with connectivity to SPP
  - A2A service enabled on the SPP appliance
  - Trusted certificates installed in SPP for the PKI you will use for authentication
  - A PFX file that secrets broker can use for client authentication to SPP
  - Access to the Internet for downloading and installing the latest plugins

This script will configure your Secrets Broker instance to trust the specified
SPP.  It will configure the A2A registration in SPP and upload the latest version of
the HashiCorp Vault plugin.  The plugin will be configured to use an SPP asset account
for the HashiCorp Vault plugin connection.  Then, the script will register and create
a mapping between the specified SPP asset account(s) and the HashiCorp Vault.  Finally,
the script will turn on the monitor that

.PARAMETER SgDevOpsAddress
Network address (IP or DNS) of the Secrets Broker.  This value may also include
the port information delimited with a colon (e.g. ssbdevops.example.com:12345).

.PARAMETER SppAddress
Network address (IP or DNS) of Spp.

.PARAMETER UserPfxFile
The path to a PFX file containing a client certificate that Secrets Broker wil

.PARAMETER VaultAssetAccount
A string containing the SPP asset account that Secrets Broker will use as the
service account for HashiCorp Vault.  Secrets Broker will pull this password
from SPP and use it to push other monitored passwords to Vault.

.PARAMETER MappedAssetAccountList
An array of strings containing one or more SPP asset accounts that should be
synchronized through Secrets Broker to HashiCorp Vault.  Each time the password
updates in SPP, the new value will automatically be pushed to HashiCorp where
developers can use it from their technology of choice.

.EXAMPLE
Initialize-SecretsBrokerForHashiCorp ssbdevops.example.com:12345 sg.example.com

.EXAMPLE
Initialize-SecretsBrokerForHashiCorp localhost 10.5.33.33 -UserPfxFile cert.pfx -VaultAssetAccount "vault\root" -MappedAssetAccounts "MyLinux12\root","VmWareEsx\SvcAccount"
#>
[CmdletBinding()]
Param(
    [Parameter(Mandatory=$true)]
    [string]$SecretsBrokerAddress,
    [Parameter(Mandatory=$true)]
    [string]$SppAddress,
    [Parameter(Mandatory=$false)]
    [string]$SppIdentityProvider = "Local",
    [Parameter(Mandatory=$true)]
    [string]$SppUserName,
    [Parameter(Mandatory=$false)]
    [SecureString]$SppPassword,
    [Parameter(Mandatory=$false)]
    [string]$UserPfxFile,
    [Parameter(Mandatory=$false)]
    [SecureString]$UserPfxFilePassword,
    [Parameter(Mandatory=$false)]
    [string]$VaultAssetAccount,
    [Parameter(Mandatory=$false)]
    [string[]]$MappedAssetAccountList
)

if (-not $PSBoundParameters.ContainsKey("ErrorAction")) { $ErrorActionPreference = "Stop" }
if (-not $PSBoundParameters.ContainsKey("Verbose")) { $VerbosePreference = $PSCmdlet.GetVariableValue("VerbosePreference") }

# Connect to SPP and verify some parameters
Write-Host -ForegroundColor Cyan "Configuring Secrets Broker to talk to SPP..."
Write-Host -ForegroundColor Green "Connecting to SPP..."
Connect-Safeguard -Insecure $SppAddress $SppIdentityProvider $SppUserName -Password $SppPassword

try
{
    Write-Host -ForegroundColor Green "Verifying user permissions..."
    $local:Me = (Get-SafeguardLoggedInUser)
    if ($local:Me -notcontains "PolicyAdmin")
    {
        throw "$($local:Me.UserName) is not a Security Policy admin"
    }

    Write-Host -ForegroundColor Green "Verifying the DevOps (A2A) API is enabled..."
    if (-not (Get-SafeguardA2aServiceStatus).IsRunning)
    {
        throw "A2A service is not enabled on $SppAddress, use Enable-SafeguardA2aService to turn it on"
    }

    Write-Host -ForegroundColor Green "Looking up specified accounts..."
    $local:Pair = ($local:VaultAssetAccount -split "\\")
    try { $local:ResolvedAccount = (Get-SafeguardPolicyAccount -AssetToGet $local:Pair[0] -AccountToGet $local:Pair[1] -e) }
    catch {}
    if (-not $local:ResolvedAccount)
    {
        throw "Unable to find vault asset account named $($local:Pair[1]) on $($local:Pair[0])"
    }
    $local:VaultAssetAccountObj = $local:ResolvedAccount
    $local:MappedAssetAccountObjList = @()
    foreach ($local:MappedAssetAccount in $MappedAssetAccountList)
    {
        try { $local:ResolvedAccount = (Get-SafeguardPolicyAccount -AssetToGet $local:Pair[0] -AccountToGet $local:Pair[1] -e) }
        catch {}
        if (-not $local:ResolvedAccount)
        {
            throw "Unable to find mapped asset account named $($local:Pair[1]) on $($local:Pair[0])"
        }
        $local:MappedAssetAccountObjList += $local:ResolvedAccount
    }

    # Initialize the Secrets Broker and connect
    Write-Host -ForegroundColor Green "Configure Secrets Broker to trust SPP..."
    Initialize-SgDevOpsAppliance -ServiceAddress $SecretsBrokerAddress -Appliance $SppAddress -Insecure

    Write-Host -ForegroundColor Green "Connecting to Secrets Broker using SPP connection..."
    Connect-SgDevOps -Insecure -ServiceAddress $SecretsBrokerAddress -Insecure

    try
    {
        Write-Host -ForegroundColor Green "Synchronizing Trusted Certificates from SPP..."
        Sync-SgDevOpsTrustedCertificate

        Write-Host -ForegroundColor Cyan "Initializing Secrets Broker DevOps API communication..."
        Write-Host -ForegroundColor Green "Configuring Secrets Broker client certificate user..."
        Install-SgDevOpsClientCertificate -CertificateFile $UserPfxFile -Password $UserPfxFilePassword

        Write-Host -ForegroundColor Green "Setting up DevOps (A2A) API registration..."
        Initialize-SgDevOpsConfiguration

        Write-Host -ForegroundColor Green "Registering asset accounts with DevOps (A2A) API..."
        foreach ($local:MappedAssetAccountObj in $local:MappedAssetAccountObjList)
        {
            Register-SgDevOpsAssetAccount $local:MappedAssetAccountObj.SystemName $local:MappedAssetAccountObj.Name -Domain $local:MappedAssetAccountObj.DomainName
        }

        Write-Host -ForegroundColor Cyan "Configuring the HashiCorp Vault plugin..."
        Write-Host -ForegroundColor Green "Downloading the latest HashiCorp Vault plugin from GitHub..."
        $local:ReleaseId = ((Invoke-RestMethod -Method GET https://api.github.com/repos/OneIdentity/SafeguardDevOpsService/releases) | Measure-Object -Property id -Maximum).Maximum
        $local:HashiCorpAsset = ((Invoke-RestMethod -Method GET "https://api.github.com/repos/OneIdentity/SafeguardDevOpsService/releases/$($local:ReleaseId)/assets") | Where-Object { $_.name -eq "HashiCorpVault.zip" })
        if (Test-Path "HashiCorpVault.zip")
        {
            Remove-Item "HashiCorpVault.zip"
        }
        Invoke-WebRequest $local:HashiCorpAsset.browser_download_url -OutFile "HashiCorpVault.zip"

        Write-Host -ForegroundColor Green "Uploading the HashiCorp Vault plugin to Secrets Broker..."
        Install-SgDevOpsPlugin -PluginZipFile "HashiCorpVault.zip"

        Write-Host -ForegroundColor Green "Configuring HashiCorp Vault plugin service account..."
        Set-SgDevOpsPluginVaultAccount -PluginName "HashiCorpVault" -Asset $local:VaultAssetAccountObj.SystemName -Account $local:VaultAssetAccountObj.Name

        Write-Host -ForegroundColor Green "Mapping asset accounts to HashiCorp Vault plugin..."
        Get-SgDevOpsRegisteredAssetAccount | ForEach-Object {
            Add-SgDevOpsMappedAssetAccount "HashiCorpVault" -Asset $_.SystemName -Account $_.AccountName -Domain $_.DomainName
        }

        Write-Host -ForegroundColor Cyan "Starting the Secrets Broker monitor..."
        Enable-SgDevOpsMonitor
    }
    finally
    {
        Write-Host -ForegroundColor Cyan "Disconnecting from Secrets Broker..."
        Disconnect-SgDevOps
    }
}
finally
{
    Write-Host -ForegroundColor Cyan "Disconnecting from SPP..."
    Disconnect-Safeguard
}

import { Component, OnInit, ViewChild, ElementRef, Renderer2 } from '@angular/core';
import { DevOpsServiceClient } from '../service-client.service';
import { switchMap, map, concatAll, tap, distinctUntilChanged, debounceTime, finalize, catchError } from 'rxjs/operators';
import { of, Observable, fromEvent } from 'rxjs';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { UploadCertificateComponent } from '../upload-certificate/upload-certificate.component';
import { EnterPassphraseComponent } from '../upload-certificate/enter-passphrase/enter-passphrase.component';
import * as $ from 'jquery';
import { ViewportScroller } from '@angular/common';
import { UntilDestroy, untilDestroyed } from '@ngneat/until-destroy';
import { EditPluginService, EditPluginMode } from '../edit-plugin.service';
import { MatDrawer } from '@angular/material/sidenav';
import { AuthService } from '../auth.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { until } from 'selenium-webdriver';

@UntilDestroy()
@Component({
  selector: 'app-main',
  templateUrl: './main.component.html',
  styleUrls: ['./main.component.scss']
})
export class MainComponent implements OnInit {

  constructor(
    private window: Window,
    private serviceClient: DevOpsServiceClient,
    private dialog: MatDialog,
    private router: Router,
    private renderer: Renderer2,
    private elementRef: ElementRef,
    private scroller: ViewportScroller,
    public editPluginService: EditPluginService,
    private authService: AuthService,
    private snackBar: MatSnackBar
  ) { }

  UserName: string;
  IdentityProviderName: string;
  A2ARegistrationName: string;
  A2AVaultRegistrationName: string;
  Thumbprint: string;
  DevOpsInstanceId: string;
  ApplianceAddress: string;

  plugins = [];
  isLoading: boolean;
  openDrawerProperties: boolean;
  openDrawerAccounts: boolean;

  isMonitoring: boolean;
  isMonitoringAvailable: boolean;

  @ViewChild('drawer', { static: false }) drawer: MatDrawer;

  @ViewChild('fileSelectInputDialog', { static: false }) fileSelectInputDialog: ElementRef;

  @ViewChild('unconfigured', { static: false }) set contentUnconfigured(content: ElementRef) {
    if (content && !this.isLoading) {
      setTimeout(() => {
        this.setArrows();
      }, 500);
    }
  }

  ngOnInit(): void {
    this.isLoading = true;
    this.ApplianceAddress =  this.window.sessionStorage.getItem('ApplianceAddress');

    if (!this.ApplianceAddress) {
      this.router.navigate(['/login']);
    } else {
      this.loginToDevOpsService()
        .pipe(
          untilDestroyed(this),
          switchMap(() => this.serviceClient.getConfiguration()),
          tap((config) => this.initializeConfig(config)),
          switchMap((config) => {
            if (config.Thumbprint) {
              return this.initializePlugins();
            } else {
              return of({});
            }
          }),
          switchMap(() => this.serviceClient.getMonitor()),
          finalize(() => this.isLoading = false)
        ).subscribe((isMonitor) => {
          // Monitoring available when we have plugins and a client certificate
          this.isMonitoringAvailable = this.plugins.length > 0 && this.Thumbprint?.length > 0;
          this.isMonitoring = isMonitor.Enabled;
        });
    }

    fromEvent(window, 'scroll').pipe(
      untilDestroyed(this),
      debounceTime(50),
      distinctUntilChanged()
    ).subscribe(() => {
      console.log('scroll');
    });
  }

  private calculateArrow(A: HTMLElement, B: HTMLElement, index: number, totalArrows: number): string {
    const isUnconfigured = index === totalArrows - 1;

    const posA = {
      x: A.offsetLeft + 150 - index * 15,
      y: A.offsetTop + A.offsetHeight - 15 + this.window.scrollY
    };

    const markerOffset = this.isMonitoring && !isUnconfigured ? 22 : 50;
    const posB = {
      x: B.offsetLeft - markerOffset,
      y: B.offsetTop + B.offsetHeight / 2 - 20
    };

    return `M ${posA.x},${posA.y} V ${posB.y} a 3,3 0 0 0 3 3 H ${posB.x}`;
  }

  private setArrows(): void {
    const colors = [ 'CorbinOrange', 'MauiSunset', 'TikiSunrise', 'AzaleaPink' ];

    try {
      const configured = $('.configured');
      const unconfigured = $('.unconfigured')[0];
      const startEl =  $('.info-container')[0];
      const pathGroup = $('#svgGroup')[0];

      $('#svgGroup path').remove();

      const total = configured.length + 1;
      const all = configured.toArray();
      all.push(unconfigured);

      all.forEach((item, index) => {
        const dStr = this.calculateArrow(startEl, item, index, total);

        const pathEl = this.renderer.createElement('path', 'svg');
        pathEl.setAttribute('d', dStr);

        const isUnconfigured = index === total - 1;
        const color =  isUnconfigured || !this.isMonitoring ? 'Black9' :  colors[index % colors.length];

        pathEl.setAttribute('class', isUnconfigured || !this.isMonitoring ? 'arrow-unconfigured' : 'arrow');
        pathEl.setAttribute('marker-end', `url(#marker${color})`);

        this.renderer.appendChild(pathGroup, pathEl);
      });
    } catch {}
  }

  initializeConfig(config: any): void {
    this.ApplianceAddress =  config.Appliance.ApplianceAddress;
    this.DevOpsInstanceId = config.Appliance.DevOpsInstanceId;
    this.UserName = config.UserName;
    this.IdentityProviderName = config.IdentityProviderName;
    this.A2ARegistrationName = config.A2ARegistrationName;
    this.A2AVaultRegistrationName = config.A2AVaultRegistrationName;
    this.Thumbprint = config.Thumbprint;
  }

  initializePlugins(): Observable<any> {
    const custom = {
      DisplayName: 'Upload Custom Plugin',
      IsUploadCustom: true,
      Accounts: []
    };
    this.plugins.push(custom);

    return this.serviceClient.getPlugins().pipe(
      // Flatten array so each plugin is emitted individually
      concatAll(),
      tap((plugin: any) => {
        plugin.IsConfigurationSetup = true;
        this.plugins.push(plugin);
      })
    );
  }

  loginToDevOpsService(): Observable<any> {
    return this.authService.getUserToken(this.ApplianceAddress)
      .pipe(
        switchMap((userTokenData) => {
          if (userTokenData?.Status === 'Success') {
            return this.serviceClient.getSafeguard();
          }
          return of();
        }),
        switchMap((safeguardData) => {
          if (!safeguardData.ApplianceAddress) {
            return this.serviceClient.putSafeguard(this.ApplianceAddress);
          }
          return of(undefined);
        }),
        switchMap(() => this.serviceClient.logon())
      );
  }

  addClientCertificate(e: Event): void {
    e.preventDefault();

    const dialogRef = this.dialog.open(UploadCertificateComponent, {
      // disableClose: true
    });

    dialogRef.afterClosed().pipe(
      switchMap(
        (fileData) => {
          if (fileData?.fileType !== 'application/x-pkcs12') {
            return of([fileData]);
          }

          const ref = this.dialog.open(EnterPassphraseComponent, {
            data: { fileName: fileData.fileName }
          });

          return ref.afterClosed().pipe(
            // Emit fileData as well as passphrase
            map(passphraseData => [fileData, passphraseData])
          );
        }
      ),
      switchMap(
        (resultArray) => {
          const fileContents = resultArray[0]?.fileContents;
          if (!fileContents) {
            return of();
          }

          const passphrase = resultArray.length > 1 ? resultArray[1] : '';
          return this.serviceClient.postConfiguration(fileContents, passphrase);
        }
      )
    ).subscribe(config => {
      this.initializeConfig(config);
    });
  }

  editPlugin(plugin: any): void {
    this.editPluginService.openProperties(plugin);
    this.openDrawerProperties = true;
    this.drawer.open();

    this.editPluginService.notifyEvent$.subscribe((data) => {
      switch (data.mode) {
        case EditPluginMode.Accounts: {
          this.drawer.close();
          this.openDrawerProperties = false;
          this.openDrawerAccounts = true;
          this.drawer.open();
        }
        break;
        case EditPluginMode.Properties: {
          this.drawer.close();
          this.openDrawerProperties = true;
          this.openDrawerAccounts = false;
          this.drawer.open();
        }
        break;
        case EditPluginMode.None: {
          this.drawer.close();
          this.openDrawerProperties = false;
          this.openDrawerAccounts = false;
          const indx = this.plugins.findIndex(x => x.Name === plugin.Name);
          if (indx > -1) {
            if (data.plugin) {
              this.plugins[indx] = data.plugin;
            } else {
              this.plugins.splice(indx, 1);
            }
          }
        }
        break;
      }
    });
  }

  uploadPlugin(): void {
    const e: HTMLElement = this.fileSelectInputDialog.nativeElement;
    e.click();
  }

  onChangeFile(files: FileList): void {
    if (!files[0]) {
      return;
    }

    const fileSelected = files[0];

    this.snackBar.open('Uploading plugin...');

    this.serviceClient.postPluginFile(fileSelected).pipe(
      finalize(() => {
        // Clear the selection
        const input = this.fileSelectInputDialog.nativeElement as HTMLInputElement;
        input.value = null;
      })
    ).subscribe(
      (x: any) => {
        if (typeof x === 'string') {
          this.snackBar.open(x, 'OK', { duration: 10000 });
        } else {
          this.snackBar.dismiss();
          x.IsConfigurationSetup = false;
          x.Accounts = [];
          x.DisplayName = x.Name;
          this.plugins.push(x);
        }
      });
  }

  updateMonitoring(enabled: boolean): void {
    this.serviceClient.postMonitor(enabled).pipe(
      untilDestroyed(this)
    ).subscribe(() => {
      this.isMonitoring = enabled;
      this.setArrows();
    });
  }

  logout(): void {
    this.serviceClient.logout().pipe(
      untilDestroyed(this)
    ).subscribe(() => {
      this.router.navigate(['/login']);
    });
  }

  restart(): void {
    // TODO: check when service is back up?
    this.serviceClient.restart().pipe(
      untilDestroyed(this)
    ).subscribe();
  }

  deleteConfig(): void {
    // TODO: confirm
    this.serviceClient.deleteConfiguration().pipe(
      untilDestroyed(this)
    ).subscribe();
  }
}


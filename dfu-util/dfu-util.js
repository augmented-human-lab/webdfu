var device = null;
(function() {
    'use strict';

    function _log(...msg) {
        console.log('|dfu-util|', ...msg);
    }

    function hex4(n) {
        let s = n.toString(16)
        while (s.length < 4) {
            s = '0' + s;
        }
        return s;
    }

    function hexAddr8(n) {
        let s = n.toString(16)
        while (s.length < 8) {
            s = '0' + s;
        }
        return "0x" + s;
    }

    function niceSize(n) {
        const gigabyte = 1024 * 1024 * 1024;
        const megabyte = 1024 * 1024;
        const kilobyte = 1024;
        if (n >= gigabyte) {
            return n / gigabyte + "GiB";
        } else if (n >= megabyte) {
            return n / megabyte + "MiB";
        } else if (n >= kilobyte) {
            return n / kilobyte + "KiB";
        } else {
            return n + "B";
        }
    }

    function formatDFUSummary(device) {
        _log('formatDFUSummary');
        const vid = hex4(device.device_.vendorId);
        const pid = hex4(device.device_.productId);
        const name = device.device_.productName;

        let mode = "Unknown"
        if (device.settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (device.settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = device.settings.configuration.configurationValue;
        const intf = device.settings["interface"].interfaceNumber;
        const alt = device.settings.alternate.alternateSetting;
        const serial = device.device_.serialNumber;
        let info = `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
        return info;
    }

    async function fixInterfaceNames(device_, interfaces) {
        _log('fixInterfaceNames');

        // Check if any interface names were not read correctly
        if (interfaces.some(intf => (intf.name == null))) {
            // Manually retrieve the interface name string descriptors
            let tempDevice = new dfu.Device(device_, interfaces[0]);
            await tempDevice.device_.open();
            await tempDevice.device_.selectConfiguration(1);
            let mapping = await tempDevice.readInterfaceNames();
            await tempDevice.close();

            for (let intf of interfaces) {
                if (intf.name === null) {
                    let configIndex = intf.configuration.configurationValue;
                    let intfNumber = intf["interface"].interfaceNumber;
                    let alt = intf.alternate.alternateSetting;
                    intf.name = mapping[configIndex][intfNumber][alt];
                }
            }
        }
    }

    function getDFUDescriptorProperties(device) {
        _log('getDFUDescriptorProperties');

        // Attempt to read the DFU functional descriptor
        // TODO: read the selected configuration's descriptor
        return device.readConfigurationDescriptor(0).then(
            data => {
                let configDesc = dfu.parseConfigurationDescriptor(data);
                let funcDesc = null;
                let configValue = device.settings.configuration.configurationValue;
                if (configDesc.bConfigurationValue == configValue) {
                    for (let desc of configDesc.descriptors) {
                        if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
                            funcDesc = desc;
                            break;
                        }
                    }
                }

                if (funcDesc) {
                    return {
                        WillDetach:            ((funcDesc.bmAttributes & 0x08) != 0),
                        ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) != 0),
                        CanUpload:             ((funcDesc.bmAttributes & 0x02) != 0),
                        CanDnload:             ((funcDesc.bmAttributes & 0x01) != 0),
                        TransferSize:          funcDesc.wTransferSize,
                        DetachTimeOut:         funcDesc.wDetachTimeOut,
                        DFUVersion:            funcDesc.bcdDFUVersion
                    };
                } else {
                    return {};
                }
            },
            error => {}
        );
    }

    // Current log div element to append to
    let logContext = null;

    function setLogContext(div) {
        logContext = div;
    };

    function clearLog(context) {
        if (typeof context === 'undefined') {
            context = logContext;
        }
        if (context) {
            context.innerHTML = "";
        }
    }

    function logDebug(msg) {
        console.log(msg);
    }

    function logInfo(msg) {
        if (logContext) {
            let info = document.createElement("p");
            info.className = "info";
            info.textContent = msg;
            logContext.appendChild(info);
        }
    }

    function logWarning(msg) {
        if (logContext) {
            let warning = document.createElement("p");
            warning.className = "warning";
            warning.textContent = msg;
            logContext.appendChild(warning);
        }
    }

    function logError(msg) {
        if (logContext) {
            let error = document.createElement("p");
            error.className = "error";
            error.textContent = msg;
            logContext.appendChild(error);
        }
    }

    function logProgress(done, total) {
        if (logContext) {
            let progressBar;
            if (logContext.lastChild.tagName.toLowerCase() == "progress") {
                progressBar = logContext.lastChild;
            }
            if (!progressBar) {
                progressBar = document.createElement("progress");
                logContext.appendChild(progressBar);
            }
            progressBar.value = done;
            if (typeof total !== 'undefined') {
                progressBar.max = total;
            }
        }
    }

    document.addEventListener('DOMContentLoaded', event => {
        _log('DOMContentLoaded');

        let connectStep1Button = document.querySelector("#connectStep1");
        let connectStep2Button = document.querySelector("#connectStep2");
        let detachButton = document.querySelector("#detach");
        let downloadStep3Button = document.querySelector("#downloadStep3");

        let statusDisplay = document.querySelector("#status");
        let infoDisplay = document.querySelector("#usbInfo");
        let dfuDisplay = document.querySelector("#dfuInfo");
        let vidField = document.querySelector("#vid");

        
        let searchParams = new URLSearchParams(window.location.search);
        let fromLandingPage = false;
        let vid = 1240;
        // Set the vendor ID from the landing page URL
        if (searchParams.has("vid")) {
            const vidString = searchParams.get("vid");
            try {
                if (vidString.toLowerCase().startsWith("0x")) {
                    vid = parseInt(vidString, 16);
                } else {
                    vid = parseInt(vidString, 10);
                }
                vidField.value = "0x" + hex4(vid).toUpperCase();
                fromLandingPage = true;
            } catch (error) {
                console.log("Bad VID " + vidString + ":" + error);
            }
        }

        // Grab the serial number from the landing page
        let serial = "";
        if (searchParams.has("serial")) {
            serial = searchParams.get("serial");
            // Workaround for Chromium issue 339054
            if (window.location.search.endsWith("/") && serial.endsWith("/")) {
                serial = serial.substring(0, serial.length-1);
            }
            fromLandingPage = true;
        }

        let configForm = document.querySelector("#configForm");

        let transferSizeField = document.querySelector("#transferSize");
        let transferSize = parseInt(transferSizeField.value);

        let dfuseStartAddressField = document.querySelector("#dfuseStartAddress");
        let dfuseUploadSizeField = document.querySelector("#dfuseUploadSize");

        let firmwareFileField = document.querySelector("#firmwareFile");
        let firmwareFile = null;

        let downloadLog = document.querySelector("#downloadLog");
        let uploadLog = document.querySelector("#uploadLog");

        let manifestationTolerant = true;


        //Get firmware file

        // TODO: CHANGE loadDfuFile TO ASYNC
        function loadDfuFile(dfuFileLocation) {
            _log('loading dfu file.. ');
            var oReq = new XMLHttpRequest();
            oReq.open("GET", dfuFileLocation, true);
            oReq.responseType = "arraybuffer";
            firmwareFile = null;
            
            oReq.onload = function (oEvent) {
                firmwareFile = oReq.response; // Note: not oReq.responseText
                
                if (firmwareFile) {
                    _log('dfu file loaded');
                }
                else {
                    _log('ERROR, unable to load dfu file');
                }
            };

            oReq.send(null);
        }

        //let device;

        function onDisconnect(reason) {
            _log('onDisconnect');
            if (reason) {
                statusDisplay.textContent = reason;
            }

          //  connectButton.textContent = "Connect";
            infoDisplay.textContent = "";
            dfuDisplay.textContent = "";
            detachButton.disabled = true;
            
           // downloadButton.disabled = true;
            firmwareFileField.disabled = true;
        }

        function onUnexpectedDisconnect(event) {
            _log('onUnexpectedDisconnect');

            if (device !== null && device.device_ !== null) {
                if (device.device_ === event.device) {
                    device.disconnected = true;
                    onDisconnect("Device disconnected");
                    device = null;
                }
            }
        }

        async function connect(device) {
            _log('connect');

            try {
                await device.open();
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            // Attempt to parse the DFU functional descriptor
            let desc = {};
            try {
                desc = await getDFUDescriptorProperties(device);
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            let memorySummary = "";
            if (desc && Object.keys(desc).length > 0) {
                device.properties = desc;
                let info = `WillDetach=${desc.WillDetach}, ManifestationTolerant=${desc.ManifestationTolerant}, CanUpload=${desc.CanUpload}, CanDnload=${desc.CanDnload}, TransferSize=${desc.TransferSize}, DetachTimeOut=${desc.DetachTimeOut}, Version=${hex4(desc.DFUVersion)}`;
                dfuDisplay.textContent += "\n" + info;
                transferSizeField.value = desc.TransferSize;
                transferSize = desc.TransferSize;
                if (desc.CanDnload) {
                    manifestationTolerant = desc.ManifestationTolerant;
                }

                if (device.settings.alternate.interfaceProtocol == 0x02) {
                    if (!desc.CanUpload) {
                        dfuseUploadSizeField.disabled = true;
                    }
                    if (!desc.CanDnload) {
                        dnloadButton.disabled = true;
                    }
                }

                if (desc.DFUVersion == 0x011a && device.settings.alternate.interfaceProtocol == 0x02) {
                    device = new dfuse.Device(device.device_, device.settings);
                    if (device.memoryInfo) {
                        let totalSize = 0;
                        for (let segment of device.memoryInfo.segments) {
                            totalSize += segment.end - segment.start;
                        }
                        memorySummary = `Selected memory region: ${device.memoryInfo.name} (${niceSize(totalSize)})`;
                        for (let segment of device.memoryInfo.segments) {
                            let properties = [];
                            if (segment.readable) {
                                properties.push("readable");
                            }
                            if (segment.erasable) {
                                properties.push("erasable");
                            }
                            if (segment.writable) {
                                properties.push("writable");
                            }
                            let propertySummary = properties.join(", ");
                            if (!propertySummary) {
                                propertySummary = "inaccessible";
                            }

                            memorySummary += `\n${hexAddr8(segment.start)}-${hexAddr8(segment.end-1)} (${propertySummary})`;
                        }
                    }
                }
            }

            // Bind logging methods
            device.logDebug = logDebug;
            device.logInfo = logInfo;
            device.logWarning = logWarning;
            device.logError = logError;
            device.logProgress = logProgress;

            // Clear logs
            clearLog(uploadLog);
            clearLog(downloadLog);

            // Display basic USB information
            statusDisplay.textContent = '';
          //  connectButton.textContent = 'Disconnect';
            infoDisplay.textContent = (
                "Name: " + device.device_.productName + "\n" +
                "MFG: " + device.device_.manufacturerName + "\n" +
                "Serial: " + device.device_.serialNumber + "\n"
            );

            // Display basic dfu-util style info
            dfuDisplay.textContent = formatDFUSummary(device) + "\n" + memorySummary;

            // Update buttons based on capabilities
            if (device.settings.alternate.interfaceProtocol == 0x01) {
                // Runtime
                detachButton.disabled = false;
                
              //  downloadButton.disabled = true;
                firmwareFileField.disabled = true;
            } else {
                // DFU
                detachButton.disabled = true;
                
                downloadStep3Button.disabled = false;
                firmwareFileField.disabled = false;
            }

            if (device.memoryInfo) {
                let dfuseFieldsDiv = document.querySelector("#dfuseFields")
                dfuseFieldsDiv.hidden = false;
                dfuseStartAddressField.disabled = false;
                dfuseUploadSizeField.disabled = false;
                let segment = device.getFirstWritableSegment();
                if (segment) {
                    device.startAddress = segment.start;
                    dfuseStartAddressField.value = "0x" + segment.start.toString(16);
                    const maxReadSize = device.getMaxReadSize(segment.start);
                    dfuseUploadSizeField.value = maxReadSize;
                    dfuseUploadSizeField.max = maxReadSize;
                }
            } else {
                let dfuseFieldsDiv = document.querySelector("#dfuseFields")
                dfuseFieldsDiv.hidden = true;
                dfuseStartAddressField.disabled = true;
                dfuseUploadSizeField.disabled = true;
            }

            
            return device;
        }

        vidField.addEventListener("change", function() {
            _log('vidField change');
            vid = parseInt(vidField.value, 16);
        });

        transferSizeField.addEventListener("change", function() {
            _log('transferSizeField change');
            transferSize = parseInt(transferSizeField.value);
        });

        dfuseStartAddressField.addEventListener("change", function(event) {
            _log('dfuseStartAddressField change');
            const field = event.target;
            let address = parseInt(field.value, 16);
            if (isNaN(address)) {
                field.setCustomValidity("Invalid hexadecimal start address");
            } else if (device && device.memoryInfo) {
                if (device.getSegment(address) !== null) {
                    device.startAddress = address;
                    field.setCustomValidity("");
                    dfuseUploadSizeField.max = device.getMaxReadSize(address);
                } else {
                    field.setCustomValidity("Address outside of memory map");
                }
            } else {
                field.setCustomValidity("");
            }
        });


         connectStep1Button.addEventListener('click', function(){
             _log('STEP1/connectButton clicked');
            connectFunction();
         });
          connectStep2Button.addEventListener('click', function(){
            _log('STEP2/connectButton2 clicked');
            connectFunction();
         });

        function connectFunction(){
            _log('connectFunction');

            _log('device', device);
            if (device) {
                device.close().then(onDisconnect);
                device = null;
            } else {
                let filters = [];
                if (serial) {
                    filters.push({ 'serialNumber': serial });
                } else if (vid) {
                    filters.push({ 'vendorId': vid });
                }

                _log('requesting usb devices..');
                navigator.usb.requestDevice({ 'filters': filters }).then(
                    async selectedDevice => {
                        _log('selectedDevice:', selectedDevice);

                        let interfaces = dfu.findDeviceDfuInterfaces(selectedDevice);
                        _log('interfaces', interfaces);

                        if (interfaces.length == 0) {
                            _log('0 interface');
                            console.log(selectedDevice);
                            statusDisplay.textContent = "The selected device does not have any USB DFU interfaces.";
                        } else if (interfaces.length == 1) {
                            _log('1 interface');

                            _log('fixInterfaceNames..');
                            await fixInterfaceNames(selectedDevice, interfaces);

                            _log('connecting..');
                            device = await connect(new dfu.Device(selectedDevice, interfaces[0]));
                            _log('device', device);

                            _log('interfaceProtocol', device.settings.alternate.interfaceProtocol);
                            if (device.settings.alternate.interfaceProtocol == 0x01) {
                                _log("100ms timeout to detach..")
                                setTimeout(function () {
                                    _log('100ms passed');

                                    downloadStep3Button.disabled = true;
                                    
                                    const productName = device.device_.productName;
                                    _log('productName', productName);

                                    const dfuLoadResult = loadDfuFileForProductName(productName);
                                    _log('dfuLoadResult', dfuLoadResult);

                                    if (dfuLoadResult) {
                                        _log('load DFU file success')
                                        connectStep2Button.disabled = false;
                                        detatchFunction()
                                    }
                                    else {
                                        _log('Failed to load DFU file');
                                        connectStep2Button.disabled = true;
                                        logWarning("Please connect a Kiwrious UV sensor");
                                        device.logWarning(productName)
                                    }
                                }, 100);
                            }
                        }
                    }
                ).catch(error => {
                    _log('ERROR', error);
                    statusDisplay.textContent = error;
                });
            }
        }

        function loadDfuFileForProductName(productName) {
            var dfuFileName = getDfuFileNameForProductName(productName);
            if (!dfuFileName) {
                _log('unable to find dfu file name');
                return false;
            }

            loadDfuFile(dfuFileName);
            return true;
        }

        function getDfuFileNameForProductName(productName) {
            if (productName.includes("UV")) {
                return './SENSOR_UV.dfu';
            }
            else if (productName.includes("Heart Rate")) {
                return './SENSOR_HR.dfu';
            }
            else {
                _log('invalid producutName', productName)
                return null;
            }
        }

        function detatchFunction(){
            if (device) {
                            console.log("detatch called")

                device.detach().then(
                    async len => {
                        let detached = false;
                        try {
                            await device.close();
                            await device.waitDisconnected(5000);
                            detached = true;
                        } catch (err) {
                            console.log("Detach failed: " + err);
                        }

                        onDisconnect();
                        device = null;
                    },
                    async error => {
                        await device.close();

                        
                        if (error === 'ControlTransferOut failed: NetworkError: A transfer error has occurred.') {
                            _log('skipping known error in dfu library.. ');
                            onDisconnect();
                        }
                        else {
                            onDisconnect(error);
                        }

                        device = null;
                    }
                );
            }
        }

        detachButton.addEventListener('click', function() {
            _log("detach clicked")
            detatchFunction();
        });

        firmwareFileField.addEventListener("change", function() {
            _log('firmwareFileField - REACHED?')
            firmwareFile = null;
            if (firmwareFileField.files.length > 0) {
                let file = firmwareFileField.files[0];
                let reader = new FileReader();
                reader.onload = function() {
                    firmwareFile = reader.result;
                };
                reader.readAsArrayBuffer(file);
            }
        });

        downloadStep3Button.addEventListener('click', async function(event) {
            _log('STEP3/downloadButton clicked');
            event.preventDefault();
            event.stopPropagation();
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                _log('validity check failed');
                return false;
            }

            connectStep1Button.disabled = true;
            connectStep2Button.disabled = true;
            downloadStep3Button.disabled = true;

            _log('device', device);
            _log('firmwareFile', firmwareFile);

            if (device && firmwareFile != null) {
                setLogContext(downloadLog);
                clearLog(downloadLog);

                try {
                    _log('getting device status..');
                    let status = await device.getStatus();
                    _log('status', status);

                    if (status.state == dfu.dfuERROR) {
                        _log('clearing device status');
                        await device.clearStatus();
                    }
                } catch (error) {
                    _log('ERROR', error);
                    device.logWarning("Failed to clear status");
                }

                _log('do_download firmware file into the device..');
                await device.do_download(transferSize, firmwareFile, manifestationTolerant).then(
                    () => {
                        _log('do_download done');
                        logInfo("Done!");
                        setLogContext(null);
                        
                        if (!manifestationTolerant) {
                            _log('waitDisconnected..')
                            device.waitDisconnected(5000).then(
                                dev => {
                                    _log('waitDisconnected ok')
                                    onDisconnect();
                                    device = null;
                                },
                                error => {
                                    _log('waitDisconnected ERROR', error);
                                    // It didn't reset and disconnect for some reason...
                                    console.log("Device unexpectedly tolerated manifestation.");
                                }
                            );
                        }
                    },
                    error => {
                        _log('do_download ERROR', error)
                        logError(error);
                        setLogContext(null);
                    }
                )
            }

            //return false;
        });

        // Check if WebUSB is available
        if (typeof navigator.usb !== 'undefined') {
            navigator.usb.addEventListener("disconnect", onUnexpectedDisconnect);            
        } else {
            statusDisplay.textContent = 'WebUSB not available.'
            connectStep1Button.disabled = true;
        }
    });
})();

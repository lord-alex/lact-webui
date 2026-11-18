// Minimal Vulkan physical device enumerator.
// Unlike vulkaninfo, it never creates a surface, so it works headless (SSH).
// Prints one JSON line per device:
// {"deviceName":..., "vendorId":..., "deviceId":..., "pciDomain":..., "pciBus":..., "pciDevice":..., "pciFunction":..., "driverVersion":...}
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vulkan/vulkan.h>

static const char *json_escape(const char *s) {
    static char buf[512];
    size_t o = 0;
    for (size_t i = 0; s[i] && o < sizeof(buf) - 8; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"' || c == '\\') { buf[o++] = '\\'; buf[o++] = c; }
        else if (c < 0x20) { o += (size_t)snprintf(buf + o, 8, "\\u%04x", c); }
        else buf[o++] = (char)c;
    }
    buf[o] = 0;
    return buf;
}

int main(void) {
    VkApplicationInfo app = {0};
    app.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    app.pApplicationName = "lact-webui-vulkan-enum";
    app.apiVersion = VK_API_VERSION_1_1;

    VkInstanceCreateInfo ici = {0};
    ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    ici.pApplicationInfo = &app;

    VkInstance instance;
    VkResult res = vkCreateInstance(&ici, NULL, &instance);
    if (res != VK_SUCCESS) {
        fprintf(stderr, "vkCreateInstance failed: %d\n", res);
        return 1;
    }

    uint32_t count = 0;
    if (vkEnumeratePhysicalDevices(instance, &count, NULL) != VK_SUCCESS || count == 0) {
        fprintf(stderr, "no physical devices\n");
        return 1;
    }
    VkPhysicalDevice *devices = malloc(count * sizeof(VkPhysicalDevice));
    vkEnumeratePhysicalDevices(instance, &count, devices);

    for (uint32_t i = 0; i < count; i++) {
        VkPhysicalDeviceProperties props;
        vkGetPhysicalDeviceProperties(devices[i], &props);

        // check for VK_EXT_pci_bus_info
        uint32_t extCount = 0;
        VkPhysicalDevicePCIBusInfoPropertiesEXT pci = {0};
        pci.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PCI_BUS_INFO_PROPERTIES_EXT;
        int havePci = 0;
        if (vkEnumerateDeviceExtensionProperties(devices[i], NULL, &extCount, NULL) == VK_SUCCESS && extCount > 0) {
            VkExtensionProperties *exts = malloc(extCount * sizeof(VkExtensionProperties));
            if (vkEnumerateDeviceExtensionProperties(devices[i], NULL, &extCount, exts) == VK_SUCCESS) {
                for (uint32_t e = 0; e < extCount; e++) {
                    if (strcmp(exts[e].extensionName, "VK_EXT_pci_bus_info") == 0) { havePci = 1; break; }
                }
            }
            free(exts);
        }
        if (havePci) {
            VkPhysicalDeviceProperties2 props2 = {0};
            props2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
            props2.pNext = &pci;
            vkGetPhysicalDeviceProperties2(devices[i], &props2);
        }

        printf("{\"deviceName\":\"%s\",\"vendorId\":%u,\"deviceId\":%u,"
               "\"pciDomain\":%u,\"pciBus\":%u,\"pciDevice\":%u,\"pciFunction\":%u,"
               "\"driverVersion\":%u,\"apiVersion\":\"%u.%u.%u\"}\n",
               json_escape(props.deviceName), props.vendorID, props.deviceID,
               havePci ? pci.pciDomain : 0, havePci ? pci.pciBus : 0,
               havePci ? pci.pciDevice : 0, havePci ? pci.pciFunction : 0,
               props.driverVersion,
               VK_API_VERSION_MAJOR(props.apiVersion), VK_API_VERSION_MINOR(props.apiVersion),
               VK_API_VERSION_PATCH(props.apiVersion));
    }

    free(devices);
    vkDestroyInstance(instance, NULL);
    return 0;
}

package mirror

import (
	"context"
	"net"
	"net/netip"
	"net/url"
	"strings"
)

type ipResolver interface {
	LookupIP(context.Context, string, string) ([]net.IP, error)
}
type dialContextFunc func(context.Context, string, string) (net.Conn, error)

func validateURL(ctx context.Context, raw string, allowedHosts []string) (*url.URL, error) {
	return validateURLWithResolver(ctx, raw, allowedHosts, net.DefaultResolver)
}

func validateURLWithResolver(ctx context.Context, raw string, allowedHosts []string, resolver ipResolver) (*url.URL, error) {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "http" && target.Scheme != "https" || target.User != nil || target.Hostname() == "" || target.Opaque != "" {
		return nil, &Error{Code: "INVALID_URL", Message: "upstream URL must use http or https without credentials"}
	}
	host := strings.ToLower(strings.TrimSuffix(target.Hostname(), "."))
	if !hostAllowed(host, allowedHosts) {
		return nil, &Error{Code: "REDIRECT_BLOCKED", Message: "upstream host is not allowed"}
	}
	if _, err := publicAddresses(ctx, host, resolver); err != nil {
		return nil, err
	}
	return target, nil
}

func hostAllowed(host string, allowedHosts []string) bool {
	for _, raw := range allowedHosts {
		allowed := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(raw), "."))
		if allowed != "" && (host == allowed || strings.HasSuffix(host, "."+allowed)) {
			return true
		}
	}
	return false
}

func publicAddresses(ctx context.Context, host string, resolver ipResolver) ([]net.IP, error) {
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	addresses := []net.IP{}
	if ip := net.ParseIP(host); ip != nil {
		addresses = append(addresses, ip)
	} else {
		var err error
		addresses, err = resolver.LookupIP(ctx, "ip", host)
		if ctx.Err() != nil {
			return nil, contextError(ctx)
		}
		if err != nil || len(addresses) == 0 {
			return nil, &Error{Code: "DNS_ERROR", Message: "upstream DNS lookup failed"}
		}
	}
	for _, address := range addresses {
		if blockedIP(address) {
			return nil, &Error{Code: "PRIVATE_ADDRESS", Message: "upstream resolves to a non-public address"}
		}
	}
	return addresses, nil
}

func publicDialContext(resolver ipResolver, dial dialContextFunc) dialContextFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, &Error{Code: "INVALID_URL", Message: "invalid upstream address"}
		}
		addresses, err := publicAddresses(ctx, host, resolver)
		if err != nil {
			return nil, err
		}
		// 校验整个新解析集后只拨号具体 IP，杜绝二次解析与混合公网/私网答案。
		for _, ip := range addresses {
			if ctx.Err() != nil {
				return nil, contextError(ctx)
			}
			connection, dialErr := dial(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return connection, nil
			}
		}
		if ctx.Err() != nil {
			return nil, contextError(ctx)
		}
		return nil, &Error{Code: "UPSTREAM_ERROR", Message: "upstream address is not reachable"}
	}
}

var reservedNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/96"), netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("fec0::/10"), netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3fff::/20"), netip.MustParsePrefix("5f00::/16"),
}

func blockedIP(ip net.IP) bool {
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() {
		return true
	}
	for _, prefix := range reservedNetworks {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}
